import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, CheckCircle2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'

const readiness = [
    'Drone telemetry nominal',
    'Detection feed synchronized',
    'Safe corridor available',
    'Risk model armed',
]

export function MissionStart() {
    const navigate = useNavigate()
    const [error, setError] = useState<string | null>(null)
    const [isStarting, setIsStarting] = useState(false)

    const handleStartMission = async () => {
        setIsStarting(true)
        setError(null)

        try {
            const response = await fetch('http://localhost:8000/health', { cache: 'no-store' })
            if (!response.ok) {
                throw new Error('Backend health check failed')
            }

            navigate('/mission')
        } catch {
            setError('Backend unavailable. Start the API service before launching the mission.')
            setIsStarting(false)
        }
    }

    return (
        <div className="flex h-full items-center justify-center bg-ink px-6 py-10">
            <div className="w-full max-w-5xl border border-rule bg-ink-raised">
                <div className="flex flex-col gap-4 border-b border-rule px-5 py-4 md:flex-row md:items-end md:justify-between md:px-6">
                    <div className="flex items-center gap-4">
                        <div className="flex h-10 w-10 items-center justify-center border border-rule bg-ink">
                            <ShieldCheck className="h-5 w-5 text-paper" aria-hidden />
                        </div>
                        <div>
                            <p className="font-display text-[10px] uppercase tracking-[0.2em] text-paper-dim">
                                AeroShield
                            </p>
                            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-paper md:text-3xl">
                                Mission Console
                            </h1>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 self-start border border-rule bg-ink px-2.5 py-1.5 md:self-auto">
                        <span className="h-2 w-2 bg-emerald-400" aria-hidden />
                        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-200">
                            Systems ready
                        </span>
                    </div>
                </div>

                <div className="grid gap-0 lg:grid-cols-[1.35fr_0.65fr]">
                    <section className="space-y-0 border-r border-rule">
                        <div className="border-b border-rule px-5 py-5 md:px-6">
                            <p className="eyebrow">Mission ID</p>
                            <div className="mt-3 flex flex-wrap items-center gap-3">
                                <h2 className="text-xl font-semibold text-paper md:text-2xl">AS-204 / Sector 07</h2>
                                <span className="border border-rule bg-ink px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-paper-dim">
                                    Simulated
                                </span>
                            </div>
                        </div>

                        <div className="grid gap-0 border-b border-rule sm:grid-cols-3">
                            <div className="border-r border-rule p-4 md:p-5">
                                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-paper-dim">
                                    Launch window
                                </p>
                                <p className="mt-2 text-lg font-semibold text-paper">14:22Z</p>
                            </div>
                            <div className="border-r border-rule p-4 md:p-5">
                                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-paper-dim">
                                    Area
                                </p>
                                <p className="mt-2 text-lg font-semibold text-paper">4.2 km²</p>
                            </div>
                            <div className="p-4 md:p-5">
                                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-paper-dim">
                                    Drone
                                </p>
                                <p className="mt-2 text-lg font-semibold text-paper">Aero-12</p>
                            </div>
                        </div>

                        <div className="px-5 py-5 md:px-6">
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-paper-dim">
                                    Readiness status
                                </p>
                                <div className="flex items-center gap-2 text-emerald-300">
                                    <CheckCircle2 size={14} aria-hidden />
                                    <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                                        Nominal
                                    </span>
                                </div>
                            </div>

                            <ul className="space-y-2.5">
                                {readiness.map((item) => (
                                    <li key={item} className="flex items-center gap-2.5 text-sm text-paper-dim">
                                        <CheckCircle2 size={13} className="text-emerald-300" aria-hidden />
                                        <span>{item}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </section>

                    <aside className="flex flex-col justify-between p-5 md:p-6">
                        <div className="space-y-4">
                            <div>
                                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-paper-dim">
                                    Launch status
                                </p>
                                <p className="mt-2 text-sm leading-6 text-paper-dim">
                                    Mission hardware, telemetry, and route planning have completed their pre-checks.
                                </p>
                            </div>

                            <div className="border border-rule bg-ink p-3">
                                <div className="flex items-center gap-2 text-paper-dim">
                                    <span className="h-2 w-2 bg-emerald-400" aria-hidden />
                                    <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                                        Awaiting operator launch
                                    </span>
                                </div>
                            </div>
                        </div>

                        {error && (
                            <p className="mt-4 border border-hazard/40 bg-hazard/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-hazard">
                                {error}
                            </p>
                        )}

                        <Button
                            type="button"
                            onClick={handleStartMission}
                            disabled={isStarting}
                            className="mt-6 w-full justify-center border-rule-bright bg-ink px-4 py-2.5 text-[11px] transition-colors hover:border-paper-dim hover:bg-ink-hover disabled:opacity-60"
                            icon={<ArrowRight size={14} aria-hidden />}
                        >
                            {isStarting ? 'Launching...' : 'Start Mission'}
                        </Button>
                    </aside>
                </div>
            </div>
        </div>
    )
}
