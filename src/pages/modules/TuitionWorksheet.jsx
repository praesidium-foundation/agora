import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useModulePermission } from '../../lib/usePermission'
import AYESelector from '../../components/AYESelector'
import AppShell from '../../components/AppShell'
import Card from '../../components/Card'
import Badge from '../../components/Badge'
import SectionLabel from '../../components/SectionLabel'
import Breadcrumb from '../../components/Breadcrumb'

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

// Schema target — 102% of expenses, fixed in migration 003 (was 1.20 typo in 001).
const RATIO_TARGET = 1.02

function Row({ label, value, valueClassName = '' }) {
  return (
    <div className="flex justify-between items-baseline text-sm">
      <span className="font-body text-muted">{label}</span>
      <span className={`font-body text-navy tabular-nums ${valueClassName}`}>
        {value}
      </span>
    </div>
  )
}

function Section({ children, divided = false }) {
  return (
    <div
      className={`space-y-1 ${divided ? 'pt-3 border-t-[0.5px] border-card-border' : ''}`}
    >
      {children}
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
    <Card
      title={`Scenario ${s.scenario_label}`}
      action={s.is_recommended ? <Badge variant="navy">Recommended</Badge> : null}
    >
      <div className="space-y-4">
        <Section>
          <Row label="Proposed Rate" value={usd.format(s.proposed_rate)} />
          <Row label="Curriculum Fee" value={usd.format(s.curriculum_fee_rate)} />
          <Row label="Enrollment Fee" value={usd.format(s.enrollment_fee_rate)} />
          <Row label="Volunteer Buyout" value={usd.format(s.volunteer_buyout_fee)} />
        </Section>

        <Section divided>
          <Row label="Students" value={s.projected_students} />
          <Row label="Families" value={totalFamilies} />
        </Section>

        <Section divided>
          <Row label="Net Tuition" value={usd.format(s.net_tuition || 0)} />
          <Row
            label="Ed Program $"
            value={usd.format(s.total_ed_program_dollars || 0)}
          />
          <Row
            label="Projected Expenses"
            value={usd.format(s.projected_expenses)}
          />
        </Section>

        <div className="space-y-2 pt-3 border-t-[0.5px] border-card-border">
          <div className="flex justify-between items-center text-sm">
            <span className="flex items-center gap-2 font-body text-muted">
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${
                  ratioGood ? 'bg-status-green' : 'bg-status-red'
                }`}
              />
              Ratio
            </span>
            <span
              className={`tabular-nums font-medium ${
                ratioGood ? 'text-status-green' : 'text-status-red'
              }`}
            >
              {ratioDisplay}
            </span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="font-body text-muted">Fundraising</span>
            <span
              className={`font-body tabular-nums ${
                fundraising > 0 ? 'text-status-amber font-medium' : 'text-navy'
              }`}
            >
              {usd.format(fundraising)}
            </span>
          </div>
        </div>
      </div>
    </Card>
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
      <AppShell>
        <p className="text-muted">Loading…</p>
      </AppShell>
    )
  }

  if (!allowed) {
    return (
      <AppShell>
        <Breadcrumb items={[{ label: 'Budget' }, { label: 'Tuition' }]} />
        <h1 className="font-display text-navy text-[28px] mb-3 leading-tight">
          You do not have access to this module.
        </h1>
        <p className="text-body mb-6">
          Tuition Worksheet access requires the appropriate module permission.
        </p>
        <Link
          to="/dashboard"
          className="inline-block bg-navy text-gold px-4 py-2 rounded text-sm hover:opacity-90 transition-opacity"
        >
          Back to Dashboard
        </Link>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <Breadcrumb items={[{ label: 'Budget' }, { label: 'Tuition' }]} />
      <h1 className="font-display text-navy text-[28px] mb-1 leading-tight">
        Tuition Worksheet
      </h1>
      <p className="font-body italic text-muted mb-6">
        Tuition rates, scenarios, and projections for the selected academic year
      </p>

      <div className="mb-8">
        <AYESelector value={selectedAyeId} onChange={setSelectedAyeId} />
      </div>

      {dataError && (
        <p className="text-status-red text-sm mb-6" role="alert">
          {dataError}
        </p>
      )}

      {dataLoading && <p className="text-muted">Loading…</p>}

      {!dataLoading && !dataError && selectedAyeId && !worksheet && (
        <p className="text-muted italic">
          No tuition worksheet exists for {aye?.label || 'this AYE'} yet.
        </p>
      )}

      {!dataLoading && worksheet && (
        <>
          {worksheet.narrative && (
            <section className="mb-10">
              <SectionLabel>Recommendation</SectionLabel>
              <div className="max-w-3xl">
                <Card>
                  <p className="font-body italic text-body leading-relaxed">
                    {worksheet.narrative}
                  </p>
                </Card>
              </div>
            </section>
          )}

          <section>
            <SectionLabel>Scenarios</SectionLabel>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {scenarios.map((s) => (
                <ScenarioCard key={s.id} s={s} />
              ))}
            </div>
          </section>
        </>
      )}
    </AppShell>
  )
}

export default TuitionWorksheet
