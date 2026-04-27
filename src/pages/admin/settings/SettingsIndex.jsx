import { Link } from 'react-router-dom'
import AppShell from '../../../components/AppShell'
import Breadcrumb from '../../../components/Breadcrumb'

const SETTINGS = [
  {
    to: '/admin/settings/organization',
    title: 'Organization',
    body: 'School info, fiscal year, org acronyms, board & committees.',
  },
  {
    to: '/admin/settings/brand',
    title: 'Brand',
    body: 'Logo, fonts, colors, tagline, letterhead.',
  },
  {
    to: '/admin/settings/financial',
    title: 'Financial',
    body: 'Chart of Accounts, KPI definitions, default targets, variance thresholds.',
  },
  {
    to: '/admin/settings/module-configuration',
    title: 'Module Configuration',
    body: 'Module-to-account mappings, tuition schedule, sibling discount model.',
  },
]

function SettingsIndex() {
  return (
    <AppShell>
      <Breadcrumb items={[{ label: 'Admin' }, { label: 'Settings' }]} />
      <h1 className="font-display text-navy text-[28px] mb-1 leading-tight">
        School Settings
      </h1>
      <p className="font-body italic text-muted mb-8">
        Configure organizational, brand, financial, and module-level settings
        for this school.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl">
        {SETTINGS.map((s) => (
          <Link
            key={s.to}
            to={s.to}
            className="block bg-white border-[0.5px] border-card-border rounded-[10px] px-5 py-[18px] hover:border-navy/40 hover:shadow-sm transition-all"
          >
            <h2 className="font-display text-[14px] text-navy tracking-[0.08em] uppercase mb-2">
              {s.title}
            </h2>
            <p className="font-body text-body text-sm leading-relaxed">
              {s.body}
            </p>
          </Link>
        ))}
      </div>
    </AppShell>
  )
}

export default SettingsIndex
