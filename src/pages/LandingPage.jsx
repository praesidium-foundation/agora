import { useNavigate } from 'react-router-dom'

function LandingPage() {
  const navigate = useNavigate()

  return (
    // Page restructured as a flex column so the hero centers vertically
    // in the upper region while the Praesidium attribution pins to the
    // bottom regardless of viewport height. Landing page is the FIRST
    // entry point visitors hit — Agora/Praesidium identity belongs here
    // alongside the login page (architecture §10.7 brand surface
    // separation).
    <div className="min-h-screen bg-navy text-white flex flex-col">
      <div className="flex-1 flex items-center justify-center p-6">
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

      {/* Praesidium attribution footer. White-text variant of the
          Agora wordmark against the navy background. Width scales
          120 → 160px on the sm breakpoint so it doesn't dominate on
          mobile-narrow viewports. The legal line beneath adds the
          "Inc." precision the wordmark alone can't carry. */}
      <footer className="w-full text-center pb-8 px-4">
        <img
          src="/Agora logo wt png.png"
          alt="Agora by Praesidium Foundation"
          className="mx-auto w-[120px] sm:w-[160px] h-auto opacity-90"
        />
        <p className="font-body text-white/50 text-[11px] tracking-wider mt-3">
          Agora is a product of Praesidium Foundation, Inc.
        </p>
      </footer>
    </div>
  )
}

export default LandingPage
