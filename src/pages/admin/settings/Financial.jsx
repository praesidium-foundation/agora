import AppShell from '../../../components/AppShell'
import Breadcrumb from '../../../components/Breadcrumb'
import CoaManagement from '../../../components/coa/CoaManagement'

function Financial() {
  return (
    <AppShell>
      <Breadcrumb
        items={[
          { label: 'Admin' },
          { label: 'Settings', to: '/admin/settings' },
          { label: 'Financial' },
        ]}
      />
      <h1 className="font-display text-navy text-[28px] mb-1 leading-tight">
        Financial Settings
      </h1>
      <p className="font-body italic text-muted mb-8">
        Configure the Chart of Accounts and other financial structures used
        by the budget and reporting modules.
      </p>

      <CoaManagement />
    </AppShell>
  )
}

export default Financial
