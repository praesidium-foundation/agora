function App() {
  return (
    <div className="min-h-screen bg-navy text-white flex items-center justify-center p-6">
      <div className="text-center">
        <p className="font-body uppercase tracking-[0.3em] text-gold text-sm mb-4">
          Libertas Academy
        </p>
        <h1 className="font-display text-gold text-5xl md:text-7xl mb-6">
          Libertas Agora
        </h1>
        <p className="font-body text-white/80 text-lg mb-12">
          Governance &amp; Operations
        </p>
        <button
          type="button"
          className="font-body border border-gold text-gold px-8 py-3 hover:bg-gold hover:text-navy transition-colors"
        >
          Sign In
        </button>
      </div>
    </div>
  )
}

export default App
