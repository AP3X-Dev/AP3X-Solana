import { describe, it, expect } from 'vitest';

import { HealthState } from './health-state';

describe('HealthState — initial state', () => {
  it('starts in healthy', () => {
    const h = new HealthState();
    expect(h.state()).toBe('healthy');
    expect(h.consecutiveErrors()).toBe(0);
  });

  it('exposes the documented thresholds', () => {
    expect(HealthState.DEGRADE_THRESHOLD).toBe(5);
    expect(HealthState.UNHEALTHY_THRESHOLD).toBe(10);
  });
});

describe('HealthState — degrade / unhealthy transitions', () => {
  it('4 consecutive errors keep the endpoint healthy', () => {
    const h = new HealthState();
    for (let i = 0; i < 4; i++) h.recordError();
    expect(h.state()).toBe('healthy');
    expect(h.consecutiveErrors()).toBe(4);
  });

  it('5 consecutive errors transition to degraded', () => {
    const h = new HealthState();
    for (let i = 0; i < 5; i++) h.recordError();
    expect(h.state()).toBe('degraded');
  });

  it('9 consecutive errors are still degraded', () => {
    const h = new HealthState();
    for (let i = 0; i < 9; i++) h.recordError();
    expect(h.state()).toBe('degraded');
  });

  it('10 consecutive errors transition to unhealthy', () => {
    const h = new HealthState();
    for (let i = 0; i < 10; i++) h.recordError();
    expect(h.state()).toBe('unhealthy');
  });

  it('errors beyond 10 stay in unhealthy', () => {
    const h = new HealthState();
    for (let i = 0; i < 25; i++) h.recordError();
    expect(h.state()).toBe('unhealthy');
    expect(h.consecutiveErrors()).toBe(25);
  });

  it('recordError returns the post-transition state', () => {
    const h = new HealthState();
    for (let i = 0; i < 4; i++) expect(h.recordError()).toBe('healthy');
    expect(h.recordError()).toBe('degraded');
    for (let i = 0; i < 4; i++) expect(h.recordError()).toBe('degraded');
    expect(h.recordError()).toBe('unhealthy');
  });
});

describe('HealthState — recovery via single success', () => {
  it('1 success from degraded snaps back to healthy', () => {
    const h = new HealthState();
    for (let i = 0; i < 5; i++) h.recordError();
    expect(h.state()).toBe('degraded');
    h.recordSuccess();
    expect(h.state()).toBe('healthy');
    expect(h.consecutiveErrors()).toBe(0);
  });

  it('1 success from unhealthy snaps back to healthy', () => {
    const h = new HealthState();
    for (let i = 0; i < 15; i++) h.recordError();
    expect(h.state()).toBe('unhealthy');
    h.recordSuccess();
    expect(h.state()).toBe('healthy');
    expect(h.consecutiveErrors()).toBe(0);
  });

  it('success resets error count so the next 5 errors re-degrade', () => {
    const h = new HealthState();
    h.recordError();
    h.recordError();
    h.recordSuccess(); // reset
    for (let i = 0; i < 4; i++) h.recordError();
    expect(h.state()).toBe('healthy'); // only 4 post-reset errors
    h.recordError();
    expect(h.state()).toBe('degraded');
  });

  it('mixed error/success/error keeps the count at 1 after a success', () => {
    const h = new HealthState();
    h.recordError(); // 1
    h.recordError(); // 2
    h.recordSuccess(); // 0
    h.recordError(); // 1 again
    expect(h.consecutiveErrors()).toBe(1);
    expect(h.state()).toBe('healthy');
  });

  it('recordSuccess returns healthy always', () => {
    const h = new HealthState();
    expect(h.recordSuccess()).toBe('healthy');
    for (let i = 0; i < 5; i++) h.recordError();
    expect(h.recordSuccess()).toBe('healthy');
  });
});
