import { describe, it, expect, beforeEach } from 'vitest'
import { FactsStore } from '../src/evolution/stores.js'
import fs from 'fs'

describe('FactsStore.updateWhere', () => {
  const dir = '/tmp/test-facts-store-cascade'

  beforeEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
  })

  it('deletes patientHash when patch has patientHash: undefined', () => {
    const store = new FactsStore(dir)
    store.add({
      category: 'fact', importance: 3, content: 'Test',
      sourceType: 'patient', patientHash: 'patient_abc',
    })
    store.commit()

    store.updateWhere(
      f => f.patientHash === 'patient_abc',
      { patientHash: undefined as any, sourceType: 'general' },
    )

    const facts = store.all()
    expect(facts[0].patientHash).toBeUndefined()
    expect(facts[0].sourceType).toBe('general')
  })

  it('persists delete across reload', () => {
    const store = new FactsStore(dir)
    store.add({
      category: 'fact', importance: 3, content: 'Test2',
      sourceType: 'patient', patientHash: 'patient_xyz',
    })
    store.commit()

    store.updateWhere(
      f => f.patientHash === 'patient_xyz',
      { patientHash: undefined as any, sourceType: 'general' },
    )

    // Reload from disk
    const reloaded = new FactsStore(dir)
    const facts = reloaded.all()
    expect(facts[0].patientHash).toBeUndefined()
    expect(facts[0].sourceType).toBe('general')
  })
})
