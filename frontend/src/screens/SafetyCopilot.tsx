import { useCallback, useMemo, useState } from 'react'
import type { CopilotMessage } from '@/types'
import { askCopilot } from '@/lib/api'
import { COPILOT_INTRO, SUGGESTED_QUERIES } from '@/lib/mockData'
import { Composer, Conversation, CitationsRail } from '@/components/copilot/Conversation'

/**
 * Safety Copilot — a grounded consultation, not a chatbot.
 *
 * Two columns: the exchange, and a sources rail carrying the actual excerpts behind
 * each answer. The rail is the point. In mine action, an answer without provenance
 * is worse than no answer, so the design refuses to let prose appear without its
 * sources visible beside it — and marks any answer that has none.
 *
 * The corpus is a fixture and the "retrieval" is keyword overlap. That is stated on
 * the rail and in the empty state rather than dressed up, because a copilot that
 * looks more capable than it is would be the most dangerous thing in this app.
 */
export function SafetyCopilot() {
  const [messages, setMessages] = useState<CopilotMessage[]>([COPILOT_INTRO])
  const [pending, setPending] = useState(false)
  const [activeCitationId, setActiveCitationId] = useState<string | null>(null)

  const ask = useCallback(
    async (question: string) => {
      const at = new Date().toISOString()
      setMessages((prev) => [
        ...prev,
        { id: `q-${at}`, role: 'operator', text: question, at, grounded: true },
      ])
      setPending(true)
      try {
        const reply = await askCopilot(question)
        setMessages((prev) => [...prev, reply])
      } finally {
        setPending(false)
      }
    },
    [],
  )

  // The rail shows sources from the whole conversation, newest first, deduped —
  // an operator scrolling back should not lose the sources from earlier answers.
  const citations = useMemo(() => {
    const seen = new Set<string>()
    const out = []
    for (const m of [...messages].reverse()) {
      for (const c of m.citations ?? []) {
        if (seen.has(c.id)) continue
        seen.add(c.id)
        out.push(c)
      }
    }
    return out
  }, [messages])

  const asked = messages.some((m) => m.role === 'operator')

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-3 py-2">
          <h1 className="font-display text-[15px] uppercase tracking-[0.12em] text-paper">
            Safety Copilot
          </h1>
          <p className="font-mono text-[11px] text-paper-dim">
            {citations.length} source{citations.length === 1 ? '' : 's'} cited
          </p>
        </header>

        <Conversation
          messages={messages}
          pending={pending}
          activeCitationId={activeCitationId}
          onCiteHover={setActiveCitationId}
        />

        {/* Starter questions, phrased the way a field question is actually asked.
            Hidden once the operator has asked something of their own. */}
        {!asked && (
          <div className="shrink-0 px-4 pb-1">
            <div className="mx-auto max-w-2xl">
              <p className="eyebrow mb-1.5">Try</p>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTED_QUERIES.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void ask(q)}
                    disabled={pending}
                    className="border border-rule px-2 py-1 text-left text-[11px] text-paper-dim transition-colors hover:border-rule-bright hover:text-paper disabled:opacity-50"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <Composer onSubmit={(q) => void ask(q)} disabled={pending} />
      </div>

      <CitationsRail
        citations={citations}
        activeCitationId={activeCitationId}
        onHover={setActiveCitationId}
      />
    </div>
  )
}
