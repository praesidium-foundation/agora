import AppShell from '../../../components/AppShell'
import Card from '../../../components/Card'
import Breadcrumb from '../../../components/Breadcrumb'

function Organization() {
  return (
    <AppShell>
      <Breadcrumb
        items={[
          { label: 'Admin' },
          { label: 'Settings', to: '/admin/settings' },
          { label: 'Organization' },
        ]}
      />
      <h1 className="font-display text-navy text-[28px] mb-1 leading-tight">
        Organization Settings
      </h1>
      <p className="font-body italic text-muted mb-8">
        School information, fiscal year settings, org acronyms registry, and
        committee composition.
      </p>

      <Card title="Coming soon">
        <p className="font-body text-body">
          Organization-level settings will be configured here in a future
          session: school name and contact info, fiscal year boundaries, the
          org acronyms registry used across reports, and per-AYE board and
          committee composition.
        </p>
      </Card>
    </AppShell>
  )
}

export default Organization
