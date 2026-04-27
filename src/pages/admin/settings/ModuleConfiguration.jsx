import AppShell from '../../../components/AppShell'
import Card from '../../../components/Card'
import Breadcrumb from '../../../components/Breadcrumb'

function ModuleConfiguration() {
  return (
    <AppShell>
      <Breadcrumb
        items={[
          { label: 'Admin' },
          { label: 'Settings', to: '/admin/settings' },
          { label: 'Module Configuration' },
        ]}
      />
      <h1 className="font-display text-navy text-[28px] mb-1 leading-tight">
        Module Configuration
      </h1>
      <p className="font-body italic text-muted mb-8">
        Module-to-account mappings, tuition schedule template, sibling
        discount model, and other per-module configuration.
      </p>

      <Card title="Coming soon">
        <p className="font-body text-body">
          Per-module configuration will live here in a future session. The
          first build of this page will focus on module-to-account mappings —
          binding each operational module's outputs (tuition revenue,
          staffing costs, etc.) to specific Chart of Accounts entries so the
          Budget can pull from them automatically.
        </p>
      </Card>
    </AppShell>
  )
}

export default ModuleConfiguration
