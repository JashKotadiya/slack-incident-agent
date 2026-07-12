import { useState } from 'react'

function App() {
  const [status, setStatus] = useState('healthy')
  const [message, setMessage] = useState('')

  const handleCrash = async () => {
    setStatus('crashing')
    setMessage('Initiating catastrophic failure...')

    try {
      // Assuming Express backend runs on port 8080
      const response = await fetch('http://localhost:8080/api/crash', { method: 'POST' })
      const data = await response.json()

      if (!response.ok) {
        setStatus('error')
        setMessage(`❌ ${data.message || 'Server Crashed!'} Fatal log sent to Datadog.`)
      } else {
        setStatus('success')
        setMessage('✅ Server somehow survived.')
      }
    } catch (error) {
      setStatus('error')
      setMessage('❌ Network Error: The server is completely down.')
    }
  }
  const handleFrontendCrash = () => {
    setStatus('error')
    setMessage('❌ Frontend React Runtime Error! Log sent to Datadog RUM.')
    // Throw a real error for Datadog RUM to catch
    throw new Error('Catastrophic Frontend UI Failure')
  }

  return (
    <div className="container">
      <div className="glass-panel">
        <h1>Hackathon E-Commerce</h1>
        <p className="subtitle">
          This is our highly resilient e-commerce platform.<br />
          It definitely won't crash if you click this button.
        </p>

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '1rem' }}>
          <button
            className={`crash-btn ${status === 'crashing' ? 'pulse' : ''}`}
            onClick={handleCrash}
            disabled={status === 'crashing'}
          >
            {status === 'crashing' ? 'Crashing...' : 'Simulate Backend Outage'}
          </button>

          <button
            className="crash-btn"
            style={{ background: '#ff4444', color: 'white' }}
            onClick={handleFrontendCrash}
          >
            Simulate Frontend Outage
          </button>
        </div>

        {message && (
          <div className={`status-message ${status}`}>
            {message}
          </div>
        )}
      </div>
    </div>
  )
}

export default App
