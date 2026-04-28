import { BrowserRouter, Routes, Route } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import Dashboard from './pages/Dashboard'
import AYEManagement from './pages/admin/AYEManagement'
import SettingsIndex from './pages/admin/settings/SettingsIndex'
import Organization from './pages/admin/settings/Organization'
import Brand from './pages/admin/settings/Brand'
import Financial from './pages/admin/settings/Financial'
import ModuleConfiguration from './pages/admin/settings/ModuleConfiguration'
import TuitionWorksheet from './pages/modules/TuitionWorksheet'
import BudgetStage from './pages/modules/BudgetStage'
import ProtectedRoute from './lib/ProtectedRoute'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/ayes"
          element={
            <ProtectedRoute>
              <AYEManagement />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <ProtectedRoute>
              <SettingsIndex />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/settings/organization"
          element={
            <ProtectedRoute>
              <Organization />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/settings/brand"
          element={
            <ProtectedRoute>
              <Brand />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/settings/financial"
          element={
            <ProtectedRoute>
              <Financial />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/settings/module-configuration"
          element={
            <ProtectedRoute>
              <ModuleConfiguration />
            </ProtectedRoute>
          }
        />
        <Route
          path="/modules/tuition"
          element={
            <ProtectedRoute>
              <TuitionWorksheet />
            </ProtectedRoute>
          }
        />
        <Route
          path="/modules/budget/:stageId"
          element={
            <ProtectedRoute>
              <BudgetStage />
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}

export default App
