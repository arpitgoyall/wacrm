import { describe, it, expect } from 'vitest'
import { isSlaBreach } from './sla'

const NOW = new Date('2026-09-07T12:00:00Z')
const minsAgo = (m: number) =>
  new Date(NOW.getTime() - m * 60_000).toISOString()

describe('isSlaBreach', () => {
  it('breaches: unanswered customer message older than the threshold', () => {
    expect(
      isSlaBreach({
        latestSenderType: 'customer',
        latestMessageAt: minsAgo(20),
        slaMinutes: 15,
        slaNotifiedAt: null,
        now: NOW,
      }),
    ).toBe(true)
  })

  it('no breach when the last message is from an agent', () => {
    expect(
      isSlaBreach({
        latestSenderType: 'agent',
        latestMessageAt: minsAgo(60),
        slaMinutes: 15,
        slaNotifiedAt: null,
        now: NOW,
      }),
    ).toBe(false)
  })

  it('no breach before the threshold elapses', () => {
    expect(
      isSlaBreach({
        latestSenderType: 'customer',
        latestMessageAt: minsAgo(10),
        slaMinutes: 15,
        slaNotifiedAt: null,
        now: NOW,
      }),
    ).toBe(false)
  })

  it('SLA disabled (0 / negative) never breaches', () => {
    expect(
      isSlaBreach({
        latestSenderType: 'customer',
        latestMessageAt: minsAgo(120),
        slaMinutes: 0,
        slaNotifiedAt: null,
        now: NOW,
      }),
    ).toBe(false)
  })

  it('suppressed once already notified for this unanswered run', () => {
    expect(
      isSlaBreach({
        latestSenderType: 'customer',
        latestMessageAt: minsAgo(40),
        slaMinutes: 15,
        slaNotifiedAt: minsAgo(20), // marker set after the customer msg
        now: NOW,
      }),
    ).toBe(false)
  })

  it('re-arms: a newer customer message after the last notification', () => {
    expect(
      isSlaBreach({
        latestSenderType: 'customer',
        latestMessageAt: minsAgo(20), // newer than the marker
        slaMinutes: 15,
        slaNotifiedAt: minsAgo(90),
        now: NOW,
      }),
    ).toBe(true)
  })

  it('no breach with no messages', () => {
    expect(
      isSlaBreach({
        latestSenderType: null,
        latestMessageAt: null,
        slaMinutes: 15,
        slaNotifiedAt: null,
        now: NOW,
      }),
    ).toBe(false)
  })
})
