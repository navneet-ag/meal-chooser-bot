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
