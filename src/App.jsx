import { BrowserRouter, Routes, Route } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import Dashboard from './pages/Dashboard'
import AYEManagement from './pages/admin/AYEManagement'
import TuitionWorksheet from './pages/modules/TuitionWorksheet'
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
          path="/modules/tuition"
          element={
            <ProtectedRoute>
              <TuitionWorksheet />
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}

export default App
