import { useNavigate } from 'react-router-dom'

function LandingPage() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-navy text-white flex items-center justify-center p-6">
      <div className="text-center">
        <img
          src="/logo-mark-white.png"
          alt="Libertas Academy crest"
          className="h-40 mx-auto mb-8"
        />
        <p className="font-body uppercase tracking-[0.3em] text-gold text-sm mb-4">
          Libertas Academy
        </p>
        <h1 className="font-display text-gold text-5xl md:text-7xl mb-6 whitespace-nowrap">
          Libertas Agora
        </h1>
        <p className="font-body text-white/80 text-lg mb-12">
          Governance &amp; Operations
        </p>
        <button
          type="button"
          onClick={() => navigate('/login')}
          className="font-body border border-gold text-gold px-8 py-3 hover:bg-gold hover:text-navy transition-colors"
        >
          Sign In
        </button>
      </div>
    </div>
  )
}

export default LandingPage
