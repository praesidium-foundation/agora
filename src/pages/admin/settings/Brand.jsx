import AppShell from '../../../components/AppShell'
import Card from '../../../components/Card'
import Breadcrumb from '../../../components/Breadcrumb'

function Brand() {
  return (
    <AppShell>
      <Breadcrumb
        items={[
          { label: 'Admin' },
          { label: 'Settings', to: '/admin/settings' },
          { label: 'Brand' },
        ]}
      />
      <h1 className="font-display text-navy text-[28px] mb-1 leading-tight">
        Brand Settings
      </h1>
      <p className="font-body italic text-muted mb-8">
        Logo, fonts, colors, tagline, and letterhead settings.
      </p>

      <Card title="Coming soon">
        <p className="font-body text-body">
          Brand configuration will live here in a future session. For now,
          Libertas Academy's branding is hardcoded across the platform —
          per-school brand settings will be introduced when the second school
          onboards.
        </p>
      </Card>
    </AppShell>
  )
}

export default Brand
