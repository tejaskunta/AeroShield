"""AeroShield - mission report agent (PRD section 5.1).

Turns one mission's stored facts into a shareable document: the numbers come from
PostgreSQL (detection stats + review tallies), the prose comes from the LLM when a key
is configured and from a deterministic template when it is not, and the file is
rendered by WeasyPrint when it is installed and as styled HTML when it is not.

Every stage degrades rather than fails. A classroom demo with no Groq key and no
WeasyPrint still produces a real, complete, downloadable report — it is just written
by the template and delivered as HTML. The response records which path ran
(`engine`, `renderer`) rather than pretending the premium path did.

WHY THE FILESYSTEM AND NOT A TABLE
    A report is a document, not a row. It is generated on demand, written once, and
    read rarely, so it lives under `settings.reports_path` as a self-describing pair:
    `RPT-....json` (the metadata that `list_reports` reads back) and `RPT-....html`
    / `.pdf` (the artifact). This keeps the schema at three tables and makes a
    generated report inspectable in the file tree — which, for a safety record, is a
    feature. If reports ever need querying (search across missions, retention
    policy), that is a `reports` table; a directory scan is the honest minimum until
    someone needs more.
"""

import json
import logging
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models.detection import Detection
from app.schemas.report import ReportGenerateRequest, ReportRead, ReportTallies
from app.services import llm, mission_service
from app.services.detection_repository import review_tallies

logger = logging.getLogger(__name__)

# Cap the detection register in a report. A long survey can produce thousands of
# hits; a report that lists every one is unusable and the PDF would be enormous.
# The headline tallies are always complete — only the itemised list is capped, and
# the report says so when it truncates.
MAX_REGISTER_ROWS = 250


def _display_id(detection_id: int) -> str:
    """Backend int id -> the operator-facing `D-0147` form the dashboard uses."""
    return "D-{0:04d}".format(detection_id)


def _site_name(mission, stats) -> str:
    """A human name for the surveyed area.

    Prefer the mission description (operator-authored); else derive a centroid from
    the detection bounding box; else fall back to the mission name. Never blank —
    a report header reading "Site:" with nothing after it looks broken.
    """
    if mission.description and mission.description.strip():
        return mission.description.strip()

    bounds = stats.bounds
    if bounds:
        centre_lat = (bounds["min_lat"] + bounds["max_lat"]) / 2
        centre_lon = (bounds["min_lon"] + bounds["max_lon"]) / 2
        ns = "N" if centre_lat >= 0 else "S"
        ew = "E" if centre_lon >= 0 else "W"
        return "{0:.4f}{1} {2:.4f}{3}".format(
            abs(centre_lat), ns, abs(centre_lon), ew
        )
    return mission.name


def _format_flight(seconds: Optional[float]) -> str:
    if not seconds:
        return "not recorded"
    minutes, secs = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return "{0}h {1:02d}m".format(hours, minutes)
    return "{0}m {1:02d}s".format(minutes, secs)


def _template_summary(mission, stats, tallies, site: str) -> str:
    """Deterministic narrative. The offline report still has to read like a report.

    Plain subject-verb sentences assembled from the verified numbers. It cannot
    invent a figure, which is exactly the property you want from the fallback path
    in a safety record.
    """
    confirmed = tallies["confirmed"]
    flagged = tallies["flagged"]
    unreviewed = tallies["unreviewed"]

    sentences = [
        "Survey mission '{name}' at {site} recorded {total} detection{plural} "
        "over a flight time of {flight}.".format(
            name=mission.name, site=site, total=tallies["total"],
            plural="" if tallies["total"] == 1 else "s",
            flight=_format_flight(stats.duration_seconds),
        )
    ]

    if stats.mean_confidence is not None:
        sentences.append(
            "Mean model confidence was {0:.2f} (peak {1:.2f}).".format(
                stats.mean_confidence, stats.max_confidence or stats.mean_confidence
            )
        )

    if tallies["total"] == 0:
        sentences.append(
            "No hazards were detected; the ground surveyed can be considered clear "
            "pending any area outside the flight track."
        )
    else:
        sentences.append(
            "Of these, {confirmed} were confirmed by an operator, {dismissed} were "
            "dismissed as false positives, {flagged} were flagged for EOD tasking, "
            "and {unreviewed} remain unreviewed.".format(
                confirmed=confirmed, dismissed=tallies["dismissed"],
                flagged=flagged, unreviewed=unreviewed,
            )
        )
        if confirmed or flagged:
            sentences.append(
                "Confirmed and flagged detections are treated as live hazards: the "
                "area is not clear and standard standoff and marking procedures apply "
                "until a demining team completes technical clearance."
            )
        elif unreviewed:
            sentences.append(
                "{0} detection(s) still require human review before any clearance "
                "conclusion can be drawn.".format(unreviewed)
            )
        else:
            sentences.append(
                "All detections were reviewed and dismissed; no confirmed hazards "
                "remain from this mission."
            )

    return " ".join(sentences)


async def _compose_summary(mission, stats, tallies, site: str) -> Tuple[str, str]:
    """Narrative + which engine wrote it. LLM if available and sane, else template.

    The LLM is given the verified numbers and asked to write the report prose. If it
    returns nothing (no key, timeout, error) we fall back to the template. Unlike the
    copilot there is no retrieval to stay grounded against here — the facts are all in
    the prompt — so the guardrail is simply that the template is always available.
    """
    fallback = _template_summary(mission, stats, tallies, site)
    if not llm.llm_available():
        return fallback, "template"

    facts = {
        "mission": mission.name,
        "site": site,
        "status": mission.status,
        "flight_time": _format_flight(stats.duration_seconds),
        "total_detections": tallies["total"],
        "confirmed": tallies["confirmed"],
        "dismissed": tallies["dismissed"],
        "flagged": tallies["flagged"],
        "unreviewed": tallies["unreviewed"],
        "mean_confidence": stats.mean_confidence,
        "geotagged": stats.geotagged_detections,
    }
    system = (
        "You write the summary paragraph of a landmine-detection drone survey report. "
        "Use ONLY the facts provided; never invent numbers. Be factual and concise, "
        "3-5 sentences, plain prose, no markdown, no headings. State clearly whether "
        "the area is clear or contains live hazards based on the confirmed/flagged "
        "counts. You do not authorise clearance."
    )
    user = "Facts:\n{0}\n\nWrite the report summary.".format(
        json.dumps(facts, indent=2)
    )
    draft = await llm.complete(system, user, max_tokens=400, temperature=0.3)
    if draft and len(draft.strip()) > 40:
        return draft.strip(), "groq"
    return fallback, "template"


# --- rendering ---------------------------------------------------------------

def _render_html(report: ReportRead) -> str:
    """Self-contained HTML: inline CSS, no external assets.

    Inlining the stylesheet means the file renders identically offline, in an email,
    or in WeasyPrint, with no CDN round trip. The palette mirrors the dashboard's
    risk colours so a printed report and the screen tell the same story.
    """
    t = report.tallies

    def row(state: str, count: int, colour: str) -> str:
        return (
            "<tr><td style='padding:6px 10px;border-bottom:1px solid #eee'>"
            "<span style='display:inline-block;width:9px;height:9px;border-radius:2px;"
            "background:{c};margin-right:8px'></span>{s}</td>"
            "<td style='padding:6px 10px;border-bottom:1px solid #eee;"
            "text-align:right;font-variant-numeric:tabular-nums'>{n}</td></tr>"
        ).format(s=state, n=count, c=colour)

    register = "".join(
        "<li>{0}</li>".format(did) for did in report.detection_ids[:MAX_REGISTER_ROWS]
    )
    truncated = (
        "<p class='note'>Register shows the first {0} of {1} detections; the full set "
        "is in the database.</p>".format(MAX_REGISTER_ROWS, len(report.detection_ids))
        if len(report.detection_ids) > MAX_REGISTER_ROWS else ""
    )

    def metric(label: str, value: str) -> str:
        return (
            "<div class='metric'><div class='mlabel'>{l}</div>"
            "<div class='mvalue'>{v}</div></div>"
        ).format(l=label, v=value)

    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>AeroShield Report {rid}</title>
<style>
  @page {{ size: A4; margin: 20mm; }}
  body {{ font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #1a1d21; line-height: 1.5; margin: 0; }}
  .kicker {{ color: #C9922C; font-weight: 700; letter-spacing: .12em; font-size: 11px;
            text-transform: uppercase; }}
  h1 {{ font-size: 22px; margin: 2px 0 4px; }}
  .meta {{ color: #5b636e; font-size: 12.5px; margin-bottom: 18px; }}
  .metrics {{ display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0; }}
  .metric {{ flex: 1 1 120px; border: 1px solid #e6e8eb; border-radius: 8px;
            padding: 10px 12px; }}
  .mlabel {{ font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
            color: #7a828c; }}
  .mvalue {{ font-size: 18px; font-weight: 650; margin-top: 2px;
            font-variant-numeric: tabular-nums; }}
  h2 {{ font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
       color: #3a4048; border-bottom: 2px solid #1a1d21; padding-bottom: 4px;
       margin: 24px 0 10px; }}
  .summary {{ font-size: 14px; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 13px; }}
  .note {{ color: #7a828c; font-size: 12px; }}
  ul.register {{ columns: 4; font-size: 11.5px; color: #3a4048; padding-left: 18px; }}
  .badge {{ display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 11px;
           font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }}
  .draft {{ background: #eef1f4; color: #5b636e; }}
  .final {{ background: #f6e2e3; color: #D7262F; }}
  footer {{ margin-top: 30px; padding-top: 10px; border-top: 1px solid #e6e8eb;
           font-size: 10.5px; color: #9aa1aa; }}
</style></head>
<body>
  <div class="kicker">AeroShield &middot; Mission Report</div>
  <h1>{name} <span class="badge {badgecls}">{status}</span></h1>
  <div class="meta">
    Site: <strong>{site}</strong> &nbsp;&middot;&nbsp;
    Generated {gen} by {by} &nbsp;&middot;&nbsp;
    {engine} narrative, {renderer} document
  </div>

  <div class="metrics">
    {area_metric}
    {coverage_metric}
    {flight_metric}
    {total_metric}
  </div>

  <h2>Summary</h2>
  <p class="summary">{summary}</p>

  <h2>Detection review</h2>
  <table>
    <tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #1a1d21">State</th>
        <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #1a1d21">Count</th></tr>
    {confirmed_row}
    {flagged_row}
    {unreviewed_row}
    {dismissed_row}
    <tr><td style="padding:6px 10px;font-weight:650">Total</td>
        <td style="padding:6px 10px;text-align:right;font-weight:650">{total}</td></tr>
  </table>

  <h2>Detection register</h2>
  {register_note}
  <ul class="register">{register}</ul>

  <footer>
    AeroShield autonomous detection system. This report summarises uncrewed survey
    data and does not constitute technical clearance. A hazard area remains unsafe
    until cleared by a qualified demining organisation.
  </footer>
</body></html>""".format(
        rid=report.id,
        name=report.mission_name,
        site=report.site or report.mission_name,
        status=report.status,
        badgecls="final" if report.status == "final" else "draft",
        gen=report.generated_at.strftime("%Y-%m-%d %H:%M UTC"),
        by=report.generated_by,
        engine=report.engine,
        renderer=report.renderer,
        area_metric=metric("Area surveyed", _format_area(report.area_surveyed_m2)),
        coverage_metric=metric(
            "Coverage",
            "{0}%".format(report.coverage_pct) if report.coverage_pct is not None else "n/a",
        ),
        flight_metric=metric("Flight time", _format_flight(report.flight_time_s)),
        total_metric=metric("Detections", str(t.total)),
        summary=report.summary,
        confirmed_row=row("Confirmed", t.confirmed, "#D7262F"),
        flagged_row=row("Flagged for EOD", t.flagged, "#C9922C"),
        unreviewed_row=row("Unreviewed", t.unreviewed, "#8a93a0"),
        dismissed_row=row("Dismissed", t.dismissed, "#4E9E86"),
        total=t.total,
        register=register or "<li>None</li>",
        register_note=truncated,
    )


def _format_area(m2: Optional[float]) -> str:
    if m2 is None:
        return "n/a"
    if m2 >= 10_000:
        return "{0:.2f} ha".format(m2 / 10_000)
    return "{0} m2".format(int(round(m2)))


def _probe_renderer() -> str:
    """Which renderer *will* be used, without rendering.

    The HTML embeds this string in its header, so the value must be known before the
    document is built. It is a real import, not a find_spec guess: WeasyPrint can be
    installed yet fail to import when its system libraries (Pango, cairo) are absent,
    and that is exactly the case where the artifact must honestly say 'html'. Python
    caches imports, so `_render_document` re-importing this is free, and both consult
    the same truth.
    """
    global _RENDERER_CACHE
    if _RENDERER_CACHE is None:
        try:
            import weasyprint  # noqa: F401 - the import IS the test
            _RENDERER_CACHE = "weasyprint"
        except Exception:  # noqa: BLE001 - ImportError or a native-lib OSError
            _RENDERER_CACHE = "html"
    return _RENDERER_CACHE


_RENDERER_CACHE: Optional[str] = None


def _render_document(report: ReportRead, html: str) -> Tuple[bytes, str, str]:
    """Render the artifact. Returns (bytes, extension, renderer_name).

    WeasyPrint turns the HTML into a real PDF when it is importable. When it is not
    (it needs system libraries — Pango, cairo — that are not on every machine, and
    are notably awkward on a stock macOS), the styled HTML is the artifact instead.
    Both are complete, printable documents; only the format differs, and the report
    records which one it is rather than claiming a PDF that was never made.
    """
    try:
        from weasyprint import HTML  # imported lazily: optional heavy dependency
        pdf = HTML(string=html).write_pdf()
        return pdf, "pdf", "weasyprint"
    except Exception as exc:  # noqa: BLE001 - any import/render failure -> HTML
        # ImportError (not installed), OSError (missing system libs), or a render
        # error all take the same safe path: keep the HTML we already have.
        logger.info("PDF renderer unavailable (%s); delivering styled HTML", exc)
        return html.encode("utf-8"), "html", "html"


# --- persistence -------------------------------------------------------------

def _report_id(mission_id: int, stamp: datetime) -> str:
    return "RPT-MSN{0}-{1}".format(mission_id, stamp.strftime("%Y%m%d%H%M%S"))


def _write_files(report: ReportRead, doc_bytes: bytes, ext: str) -> None:
    """Persist the metadata sidecar and the document. Reports dir is created on demand."""
    root = settings.reports_path
    root.mkdir(parents=True, exist_ok=True)
    (root / "{0}.json".format(report.id)).write_text(
        json.dumps(report.model_dump(mode="json"), indent=2), encoding="utf-8"
    )
    (root / "{0}.{1}".format(report.id, ext)).write_bytes(doc_bytes)


async def generate(db: AsyncSession, payload: ReportGenerateRequest,
                   generated_by: str) -> ReportRead:
    """Produce a report for one mission. Raises LookupError if the mission is absent."""
    mission = await mission_service.get_by_id(db, payload.mission_id)
    if mission is None:
        raise LookupError(payload.mission_id)

    stats = await mission_service.compute_stats(db, mission)
    tallies = await review_tallies(db, mission.id)

    # The itemised register: newest first, capped. Only ids are needed for the table.
    id_rows = (
        await db.execute(
            select(Detection.id)
            .where(Detection.mission_id == mission.id)
            .order_by(Detection.captured_at.desc(), Detection.id.desc())
            .limit(MAX_REGISTER_ROWS + 1)
        )
    ).scalars().all()
    detection_ids = [_display_id(i) for i in id_rows]

    site = _site_name(mission, stats)
    summary, engine = await _compose_summary(mission, stats, tallies, site)

    stamp = datetime.now(timezone.utc)
    report = ReportRead(
        id=_report_id(mission.id, stamp),
        mission_id=mission.id,
        mission_name=mission.name,
        site=site,
        status="final" if payload.mark_final else "draft",
        generated_at=stamp,
        generated_by=generated_by,
        summary=summary,
        engine=engine,
        renderer=_probe_renderer(),  # decided before rendering: the HTML names it
        area_surveyed_m2=payload.area_surveyed_m2,
        coverage_pct=payload.coverage_pct,
        flight_time_s=stats.duration_seconds,
        tallies=ReportTallies(**tallies),
        detection_ids=detection_ids,
        pdf_url=None,  # set after we know the extension
        stats=stats.model_dump(mode="json"),
    )

    html = _render_html(report)
    doc_bytes, ext, renderer = _render_document(report, html)
    report = report.model_copy(update={
        "renderer": renderer,
        "pdf_url": "/api/reports/{0}/document".format(report.id),
    })
    _write_files(report, doc_bytes, ext)

    logger.info("generated report %s (engine=%s, renderer=%s, %d detections)",
                report.id, engine, renderer, report.tallies.total)
    return report


def list_reports() -> List[ReportRead]:
    """All generated reports, newest first, read back from their sidecars.

    A directory scan, not a query — see the module docstring for why a report is a
    file. Corrupt or unreadable sidecars are skipped rather than failing the whole
    list: one bad file should not hide every good report.
    """
    root = settings.reports_path
    if not root.is_dir():
        return []

    reports: List[ReportRead] = []
    for sidecar in root.glob("RPT-*.json"):
        try:
            reports.append(ReportRead(**json.loads(sidecar.read_text(encoding="utf-8"))))
        except Exception as exc:  # noqa: BLE001
            logger.warning("skipping unreadable report %s: %s", sidecar.name, exc)

    reports.sort(key=lambda r: r.generated_at, reverse=True)
    return reports


def load(report_id: str) -> Optional[ReportRead]:
    """One report by id, or None. Rejects anything that could escape the dir."""
    path = _safe_sidecar(report_id)
    if path is None or not path.is_file():
        return None
    try:
        return ReportRead(**json.loads(path.read_text(encoding="utf-8")))
    except Exception:  # noqa: BLE001
        return None


def document_path(report_id: str) -> Optional[Tuple[Path, str]]:
    """(path, media_type) for a report's document file, or None if absent."""
    base = settings.reports_path / report_id
    if _safe_sidecar(report_id) is None:  # traversal guard applies to documents too
        return None
    for ext, media in (("pdf", "application/pdf"), ("html", "text/html")):
        candidate = base.with_name(base.name + "." + ext)
        if candidate.is_file():
            return candidate, media
    return None


def _safe_sidecar(report_id: str) -> Optional[Path]:
    """Resolve a report id to its sidecar only if it stays inside the reports dir.

    The id arrives from a URL path, so it must be treated as attacker-controlled: a
    value like `../../etc/passwd` must not resolve outside the reports directory.
    Same containment rule as storage.resolve_image_path.
    """
    root = settings.reports_path.resolve()
    candidate = (settings.reports_path / "{0}.json".format(report_id)).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        logger.warning("refused report id outside reports dir: %s", report_id)
        return None
    return candidate
