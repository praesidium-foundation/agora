import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useModulePermission } from '../../lib/usePermission'
import AYESelector from '../../components/AYESelector'

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const RATIO_TARGET = 1.02

function Row({ label, value, valueClassName = '' }) {
  return (
    <div className="flex justify-between items-baseline text-sm">
      <span className="text-white/70">{label}</span>
      <span className={`text-white tabular-nums ${valueClassName}`}>{value}</span>
    </div>
  )
}

function ScenarioCard({ s }) {
  const totalFamilies =
    (s.families_1_student || 0) +
    (s.families_2_student || 0) +
    (s.families_3_student || 0) +
    (s.families_4plus_student || 0)

  const ratio = s.ed_program_ratio !== null ? Number(s.ed_program_ratio) : null
  const ratioGood = ratio !== null && ratio >= RATIO_TARGET
  const fundraising = Number(s.fundraising_needed || 0)
  const ratioDisplay = ratio !== null ? `1 : ${ratio.toFixed(2)}` : '—'

  return (
    <div className="border border-gold/30 p-5 flex flex-col">
      <div className="flex items-baseline justify-between mb-4">
        <span className="font-display text-gold text-3xl">
          {s.scenario_label}
        </span>
        {s.is_recommended && (
          <span className="bg-gold text-navy px-2 py-0.5 text-xs uppercase tracking-wider">
            Recommended
          </span>
        )}
      </div>

      <div className="space-y-1 pb-3 mb-3 border-b border-gold/20">
        <Row label="Proposed Rate" value={usd.format(s.proposed_rate)} />
        <Row label="Curriculum Fee" value={usd.format(s.curriculum_fee_rate)} />
        <Row label="Enrollment Fee" value={usd.format(s.enrollment_fee_rate)} />
        <Row
          label="Volunteer Buyout"
          value={usd.format(s.volunteer_buyout_fee)}
        />
      </div>

      <div className="space-y-1 pb-3 mb-3 border-b border-gold/20">
        <Row label="Students" value={s.projected_students} />
        <Row label="Families" value={totalFamilies} />
      </div>

      <div className="space-y-1 pb-3 mb-3 border-b border-gold/20">
        <Row label="Net Tuition" value={usd.format(s.net_tuition || 0)} />
        <Row
          label="Ed Program $"
          value={usd.format(s.total_ed_program_dollars || 0)}
        />
        <Row
          label="Projected Expenses"
          value={usd.format(s.projected_expenses)}
        />
      </div>

      <div className="space-y-2 mt-auto">
        <div className="flex justify-between items-center text-sm">
          <span className="flex items-center gap-2 text-white/70">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                ratioGood ? 'bg-green-400' : 'bg-red-400'
              }`}
            />
            Ratio
          </span>
          <span
            className={`tabular-nums font-semibold ${
              ratioGood ? 'text-green-300' : 'text-red-300'
            }`}
          >
            {ratioDisplay}
          </span>
        </div>
        <div className="flex justify-between items-center text-sm">
          <span className="text-white/70">Fundraising</span>
          <span
            className={`tabular-nums ${
              fundraising > 0 ? 'text-amber-300 font-semibold' : 'text-white'
            }`}
          >
            {usd.format(fundraising)}
          </span>
        </div>
      </div>
    </div>
  )
}

function TuitionWorksheet() {
  const { allowed, loading: permLoading } = useModulePermission(
    'tuition_worksheet',
    'view'
  )

  const [selectedAyeId, setSelectedAyeId] = useState(null)
  const [aye, setAye] = useState(null)
  const [worksheet, setWorksheet] = useState(null)
  const [scenarios, setScenarios] = useState([])
  const [dataLoading, setDataLoading] = useState(false)
  const [dataError, setDataError] = useState(null)

  useEffect(() => {
    if (!selectedAyeId || !allowed) return

    let mounted = true
    async function load() {
      setDataLoading(true)
      setDataError(null)

      const [ayeResult, wsResult] = await Promise.all([
        supabase
          .from('academic_years')
          .select('label')
          .eq('id', selectedAyeId)
          .single(),
        supabase
          .from('tuition_worksheet')
          .select('id, narrative, recommended_scenario_id')
          .eq('aye_id', selectedAyeId)
          .maybeSingle(),
      ])

      if (!mounted) return

      if (ayeResult.error) {
        setDataError(ayeResult.error.message)
        setDataLoading(false)
        return
      }
      setAye(ayeResult.data)

      if (wsResult.error) {
        setDataError(wsResult.error.message)
        setDataLoading(false)
        return
      }

      if (!wsResult.data) {
        setWorksheet(null)
        setScenarios([])
        setDataLoading(false)
        return
      }

      setWorksheet(wsResult.data)

      const { data: scenarioData, error: scenarioError } = await supabase
        .from('tuition_scenarios')
        .select('*')
        .eq('worksheet_id', wsResult.data.id)
        .order('scenario_label')

      if (!mounted) return

      if (scenarioError) {
        setDataError(scenarioError.message)
      } else {
        setScenarios(scenarioData || [])
      }
      setDataLoading(false)
    }

    load()
    return () => {
      mounted = false
    }
  }, [selectedAyeId, allowed])

  if (permLoading) {
    return (
      <div className="min-h-screen bg-navy text-white flex items-center justify-center font-body">
        <p className="text-gold">Loading…</p>
      </div>
    )
  }

  if (!allowed) {
    return (
      <div className="min-h-screen bg-navy text-white font-body">
        <header className="border-b border-gold/20 px-6 py-4 flex items-center gap-3">
          <img src="/logo-mark-white.png" alt="" className="h-10" />
          <span className="font-display text-gold text-xl">Libertas Agora</span>
        </header>
        <main className="max-w-3xl mx-auto px-6 py-12 text-center">
          <h1 className="font-display text-gold text-3xl mb-4">
            You don't have access to this module.
          </h1>
          <p className="text-white/70 mb-8">
            Tuition Worksheet access requires the appropriate module permission.
          </p>
          <Link
            to="/dashboard"
            className="inline-block border border-gold text-gold px-6 py-2 hover:bg-gold hover:text-navy transition-colors"
          >
            Back to Dashboard
          </Link>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-navy text-white font-body">
      <header className="border-b border-gold/20 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/logo-mark-white.png" alt="" className="h-10" />
          <span className="font-display text-gold text-xl">Libertas Agora</span>
        </div>
        <Link to="/dashboard" className="text-gold/80 hover:text-gold text-sm">
          ← Dashboard
        </Link>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12">
        <p className="uppercase tracking-[0.3em] text-gold text-xs mb-2">
          Libertas Academy
        </p>
        <h1 className="font-display text-gold text-4xl md:text-5xl mb-8">
          Tuition Worksheet
          {aye?.label ? ` — ${aye.label}` : ''}
        </h1>

        <div className="mb-8">
          <AYESelector value={selectedAyeId} onChange={setSelectedAyeId} />
        </div>

        {dataError && (
          <p className="text-red-300 text-sm mb-6" role="alert">
            {dataError}
          </p>
        )}

        {dataLoading && <p className="text-gold/70">Loading…</p>}

        {!dataLoading && !dataError && selectedAyeId && !worksheet && (
          <p className="text-white/60 italic">
            No tuition worksheet exists for this AYE yet.
          </p>
        )}

        {!dataLoading && worksheet && (
          <>
            {worksheet.narrative && (
              <p className="mb-8 max-w-3xl text-white/80 italic leading-relaxed">
                {worksheet.narrative}
              </p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {scenarios.map((s) => (
                <ScenarioCard key={s.id} s={s} />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  )
}

export default TuitionWorksheet
