export function distributeQuotas(n, names, randomFn) {
  const k = names.length;
  const base = Math.floor(n / k);
  const remainderCount = n % k;

  // Create array of indices [0, 1, ..., k-1]
  const indices = Array.from({ length: k }, (_, i) => i);

  // Partial Fisher-Yates: select remainderCount distinct indices
  for (let i = 0; i < remainderCount; i++) {
    // Generate random index j in range [i, k-1]
    const r = randomFn(); // returns value in [0, 1)
    const j = i + Math.floor(r * (k - i));

    // Swap indices[i] and indices[j]
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  // The first remainderCount indices get base+1, rest get base
  const selectedIndices = new Set(indices.slice(0, remainderCount));

  return names.map((name, idx) => ({
    name,
    quota: selectedIndices.has(idx) ? base + 1 : base
  }));
}

export function computeProbabilities(participants) {
  const sum = participants.reduce((s, p) => s + p.remaining, 0);

  if (sum === 0) {
    throw new Error('Sum of remaining is zero');
  }

  return participants.map(p => ({
    name: p.name,
    p: p.remaining / sum
  }));
}

export function startSession(n, names, randomFn, nowIso, sessionIndex) {
  const quotas = distributeQuotas(n, names, randomFn);
  return {
    sessionIndex,
    n,
    startedAt: nowIso,
    mealsLogged: 0,
    participants: quotas.map(q => ({
      name: q.name,
      quota: q.quota,
      remaining: q.quota
    }))
  };
}

export function pickWinner(participants, r) {
  const probs = computeProbabilities(participants);
  let cumulative = 0;
  let selected = null;

  for (const prob of probs) {
    cumulative += prob.p;
    if (r < cumulative) {
      selected = prob;
      break;
    }
  }

  // Fallback to the last participant with remaining > 0 if floating-point rounding leaves none selected
  if (selected === null) {
    for (let i = participants.length - 1; i >= 0; i--) {
      if (participants[i].remaining > 0) {
        selected = probs[i];
        break;
      }
    }
  }

  // Count participants with remaining > 0
  const activeCount = participants.filter(p => p.remaining > 0).length;
  const forced = activeCount === 1;

  return {
    name: selected.name,
    p: selected.p,
    forced
  };
}

export function drawNext(session, randomFn) {
  const r = randomFn();
  const winner = pickWinner(session.participants, r);

  const winnerParticipant = session.participants.find(p => p.name === winner.name);
  winnerParticipant.remaining--;

  session.mealsLogged++;

  return {
    winner,
    mealNumber: session.mealsLogged
  };
}

export function isSessionComplete(session) {
  return session.mealsLogged === session.n;
}
