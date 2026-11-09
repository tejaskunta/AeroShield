import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Send } from 'lucide-react'
import type { Citation, CopilotMessage } from '@/types'
import { formatZulu } from '@/lib/geo'
import { Button } from '@/components/ui/Button'

/**
 * Conversation — the operator's exchange with the copilot.
 *
 * Not chat bubbles. Operator questions are set as tracked-out display type against
 * the left edge and answers as prose beneath them, so the transcript reads like a
 * consultation record rather than a messaging app. That framing matters: this is a
 * tool someone consults before deciding how to approach a hazard, and bubbles carry
 * a casualness the subject can't afford.
 */
export function Conversation({
  messages,
  pending,
  activeCitationId,
  onCiteHover,
}: {
  messages: CopilotMessage[]
  pending: boolean
  activeCitationId: string | null
  onCiteHover: (id: string | null) => void
}) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, pending])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div className="mx-auto max-w-2xl space-y-5">
        {messages.map((m) =>
          m.role === 'operator' ? (
            <div key={m.id} className="flex gap-3">
              <span className="mt-0.5 shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-paper-faint">
                You
              </span>
              <p className="font-display text-[15px] leading-snug tracking-[0.02em] text-paper">
                {m.text}
              </p>
            </div>
          ) : (
            <Answer
              key={m.id}
              message={m}
              activeCitationId={activeCitationId}
              onCiteHover={onCiteHover}
            />
          ),
        )}

        {pending && (
          <div className="flex gap-3">
            <span className="mt-0.5 shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-paper-faint">
              Copilot
            </span>
            <p className="text-[13px] text-paper-dim">Searching the reference set…</p>
          </div>
        )}

        <div ref={endRef} />
      </div>
    </div>
  )
}

function Answer({
  message,
  activeCitationId,
  onCiteHover,
}: {
  message: CopilotMessage
  activeCitationId: string | null
  onCiteHover: (id: string | null) => void
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-1 shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-paper-faint">
        Copilot
      </span>
      <div className="min-w-0 flex-1">
        {/* An ungrounded answer is marked before it is read, not after. */}
        {!message.grounded && (
          <p className="mb-1.5 border-l-2 border-caution pl-2 font-mono text-[10px] uppercase tracking-[0.08em] text-caution">
            No supporting source found
          </p>
        )}

        <div className="space-y-2 text-[13px] leading-relaxed text-paper">
          {message.text.split('\n\n').map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>

        {/* Inline citation chips — hovering one highlights it in the rail. */}
        {message.citations && message.citations.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {message.citations.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onMouseEnter={() => onCiteHover(c.id)}
                onMouseLeave={() => onCiteHover(null)}
                onFocus={() => onCiteHover(c.id)}
                onBlur={() => onCiteHover(null)}
                className={`border px-1.5 py-px font-mono text-[10px] transition-colors ${
                  activeCitationId === c.id
                    ? 'border-paper text-paper'
                    : 'border-rule text-paper-dim hover:border-rule-bright hover:text-paper'
                }`}
              >
                [{i + 1}] {c.document}
              </button>
            ))}
          </div>
        )}

        <p className="mt-1.5 font-mono text-[9px] text-paper-faint">{formatZulu(message.at)}</p>
      </div>
    </div>
  )
}

/**
 * CitationsRail — the sources, given their own column.
 *
 * This is the screen's structural argument: in mine action an unsourced answer is
 * not a weaker answer, it is a dangerous one. So provenance gets equal billing with
 * the prose instead of being folded into a footnote, and the retrieval score is
 * shown so a weak match is visibly weak rather than quietly presented as authority.
 */
export function CitationsRail({
  citations,
  activeCitationId,
  onHover,
}: {
  citations: Citation[]
  activeCitationId: string | null
  onHover: (id: string | null) => void
}) {
  return (
    <aside className="hidden w-[300px] shrink-0 flex-col border-l border-rule bg-ink-deep xl:flex">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-rule px-3">
        <h2 className="eyebrow">Sources</h2>
        <span className="font-mono text-[10px] text-paper-faint">{citations.length}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {citations.length === 0 ? (
          <p className="p-2 text-[11px] leading-relaxed text-paper-faint">
            Sources behind each answer appear here. Ask something to populate the rail.
          </p>
        ) : (
          <div className="space-y-2">
            {citations.map((c) => (
              <article
                key={c.id}
                onMouseEnter={() => onHover(c.id)}
                onMouseLeave={() => onHover(null)}
                className={`border p-2 transition-colors ${
                  activeCitationId === c.id
                    ? 'border-paper bg-ink-hover'
                    : 'border-rule bg-ink-raised'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[11px] tracking-[0.04em] text-paper">
                    {c.document}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular text-paper-dim">
                    {c.relevance.toFixed(2)}
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[10px] text-paper-faint">
                  {c.clause} · p.{c.page}
                </p>
                {/* Relevance as a bar — a number alone doesn't convey "weak". */}
                <div className="mt-1.5 h-px w-full bg-rule">
                  <div
                    className="h-px bg-paper-dim"
                    style={{ width: `${Math.round(c.relevance * 100)}%` }}
                  />
                </div>
                <p className="mt-1.5 border-l border-rule pl-2 text-[11px] leading-relaxed text-paper-dim">
                  {c.excerpt}
                </p>
              </article>
            ))}
          </div>
        )}
      </div>

      <p className="shrink-0 border-t border-rule px-3 py-1.5 font-mono text-[9px] leading-snug text-caution/80">
        Fixture corpus. No retrieval or model is running.
      </p>
    </aside>
  )
}

/**
 * Composer — the question input, with voice.
 *
 * Voice matters here specifically: an operator asking this question may be gloved,
 * outdoors, holding equipment. Where the browser has no SpeechRecognition the button
 * says so instead of silently failing.
 */
export function Composer({
  onSubmit,
  disabled,
}: {
  onSubmit: (question: string) => void
  disabled: boolean
}) {
  const [text, setText] = useState('')
  const { supported, listening, start, stop, transcript, error } = useSpeech()

  // Fold a finished transcript into the field so it can be edited before sending.
  useEffect(() => {
    if (transcript) setText((t) => (t ? `${t} ${transcript}` : transcript))
  }, [transcript])

  const submit = () => {
    const q = text.trim()
    if (!q || disabled) return
    onSubmit(q)
    setText('')
  }

  return (
    <div className="shrink-0 border-t border-rule bg-ink px-4 py-2.5">
      <div className="mx-auto flex max-w-2xl items-end gap-2">
        <div className="flex-1">
          <label className="sr-only" htmlFor="copilot-input">
            Ask the safety copilot
          </label>
          <textarea
            id="copilot-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={2}
            placeholder={listening ? 'Listening…' : 'Ask about procedure, standoff, marking…'}
            className="w-full resize-none border border-rule bg-ink-raised px-2.5 py-1.5 text-[13px] text-paper placeholder:text-paper-faint focus:border-rule-bright focus:outline-none"
          />
          {error && <p className="mt-1 text-[10px] text-caution">{error}</p>}
        </div>

        <Button
          variant={listening ? 'danger' : 'default'}
          onClick={listening ? stop : start}
          disabled={!supported}
          title={
            supported
              ? listening
                ? 'Stop listening'
                : 'Dictate a question'
              : 'This browser has no speech recognition'
          }
          icon={listening ? <MicOff size={12} aria-hidden /> : <Mic size={12} aria-hidden />}
          className="h-[34px]"
        >
          {listening ? 'Stop' : 'Speak'}
        </Button>

        <Button
          onClick={submit}
          disabled={!text.trim() || disabled}
          icon={<Send size={12} aria-hidden />}
          className="h-[34px]"
        >
          Ask
        </Button>
      </div>

      <p className="mx-auto mt-1.5 max-w-2xl text-[10px] leading-snug text-paper-faint">
        Decision support only. Nothing here authorises entry, clearance, or disposal —
        those are an accredited EOD operator's call.
      </p>
    </div>
  )
}

/** Minimal typings for the vendor-prefixed Web Speech API. */
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  start: () => void
  stop: () => void
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

/**
 * Browser speech input, degrading cleanly.
 *
 * Kept local to this screen because it is the only place voice makes sense — a
 * general-purpose hook would invite adding microphones to forms that don't need them.
 */
function useSpeech() {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const recognition = useRef<SpeechRecognitionLike | null>(null)

  const Ctor =
    typeof window !== 'undefined'
      ? ((window as unknown as Record<string, unknown>).SpeechRecognition ??
        (window as unknown as Record<string, unknown>).webkitSpeechRecognition)
      : undefined
  const supported = typeof Ctor === 'function'

  const start = () => {
    if (!supported) return
    setError(null)
    setTranscript('')
    try {
      const instance = new (Ctor as new () => SpeechRecognitionLike)()
      instance.lang = 'en-US'
      instance.interimResults = false
      instance.continuous = false
      instance.onresult = (e) => {
        const said = e.results[0]?.[0]?.transcript
        if (said) setTranscript(said)
      }
      instance.onerror = (e) => {
        setError(
          e.error === 'not-allowed'
            ? 'Microphone access was blocked. Allow it in the browser to dictate.'
            : `Speech input failed: ${e.error}`,
        )
        setListening(false)
      }
      instance.onend = () => setListening(false)
      recognition.current = instance
      instance.start()
      setListening(true)
    } catch {
      setError('Speech input could not start in this browser.')
      setListening(false)
    }
  }

  const stop = () => {
    recognition.current?.stop()
    setListening(false)
  }

  return { supported, listening, start, stop, transcript, error }
}
