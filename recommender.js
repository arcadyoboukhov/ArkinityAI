const { exec } = require('child_process');
const crypto = require('crypto');

const TIME_DECAY_MS = 7 * 24 * 60 * 60 * 1000;

// Simple recommender with lightweight, deterministic feature extraction
// - Text features from filename (hashed bag-of-words)
// - Deterministic pseudo-random audio/visual features (fallback)
// - KMeans implemented minimally for clustering

function hashToSeed(s) {
  const h = crypto.createHash('md5').update(s).digest();
  return h.readUInt32LE(0);
}

function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tokenize(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function textVector(name, size = 64) {
  const vec = new Array(size).fill(0);
  const toks = tokenize(name);
  for (const t of toks) {
    const seed = hashToSeed(t);
    const rnd = mulberry32(seed)();
    const idx = Math.floor(rnd * size);
    vec[idx] += 1;
  }
  return vec;
}

function deterministicRandomVector(key, len = 16) {
  const seed = hashToSeed(key);
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < len; i++) out.push(rnd());
  return out;
}

function concat(a, b, c) {
  return a.concat(b).concat(c);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] || 0) * (b[i] || 0);
  return s;
}

function cosSim(a, b) {
  const da = Math.sqrt(a.reduce((s, x) => s + (x || 0) * (x || 0), 0)) || 1;
  const db = Math.sqrt(b.reduce((s, x) => s + (x || 0) * (x || 0), 0)) || 1;
  return dot(a, b) / (da * db);
}

function parseCatalogKey(key) {
  if (!key || typeof key !== 'string') return null;
  const parts = key.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return null;
  const category = parts[0];
  const file = parts.slice(1).join('/');
  if (!category || !file) return null;
  return { category, file };
}

// Minimal kmeans (Euclidean) - not optimized, but small datasets are fine
function kmeans(data, k = 8, maxIter = 40) {
  if (!data.length) return { labels: [], centroids: [] };
  const dim = data[0].length;
  const rnd = mulberry32(123456);
  const centroids = [];
  const used = new Set();
  while (centroids.length < Math.min(k, data.length)) {
    const idx = Math.floor(rnd() * data.length);
    if (used.has(idx)) continue;
    used.add(idx);
    centroids.push(data[idx].slice());
  }

  let labels = new Array(data.length).fill(0);
  for (let it = 0; it < maxIter; it++) {
    let changed = 0;
    for (let i = 0; i < data.length; i++) {
      let best = 0, bestd = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        let d = 0;
        const ci = centroids[c], vi = data[i];
        for (let j = 0; j < dim; j++) {
          const diff = (vi[j] || 0) - (ci[j] || 0);
          d += diff * diff;
        }
        if (d < bestd) { best = c; bestd = d; }
      }
      if (labels[i] !== best) { labels[i] = best; changed++; }
    }
    if (changed === 0) break;

    // recompute centroids
    const counts = new Array(centroids.length).fill(0);
    for (let c = 0; c < centroids.length; c++) centroids[c] = new Array(dim).fill(0);
    for (let i = 0; i < data.length; i++) {
      const c = labels[i]; counts[c]++;
      for (let j = 0; j < dim; j++) centroids[c][j] += (data[i][j] || 0);
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) continue;
      for (let j = 0; j < dim; j++) centroids[c][j] /= counts[c];
    }
  }

  return { labels, centroids };
}

class Recommender {
  constructor() {
    this.index = []; // list of { key, category, file, feature }
    this.keyToIndex = {};
    this.labels = [];
    this.centroids = [];
  }

  getInteractionWeight(meta = {}, now = Date.now()) {
    const watchTime = Number(meta.watchTime || 0);
    const likes = Number(meta.likes || 0);
    const base = watchTime + (likes * 3);
    const lastSeenAt = Number(meta.lastSeenAt || 0);
    if (!lastSeenAt) return base;
    const ageMs = Math.max(0, now - lastSeenAt);
    const decay = Math.exp(-ageMs / TIME_DECAY_MS);
    return base * decay;
  }

  getRecentClusterCounts(recentKeys = []) {
    const counts = {};
    if (!Array.isArray(recentKeys) || !recentKeys.length) return counts;

    for (const key of recentKeys) {
      const i = this.keyToIndex[key];
      if (i === undefined) continue;
      const label = this.labels[i];
      if (label === undefined || label === null) continue;
      counts[label] = (counts[label] || 0) + 1;
    }
    return counts;
  }

  buildMultiInterestProfiles(userBehavior = {}, maxInterests = 3) {
    const idx = this.index;
    if (!idx.length) return [];
    const dim = idx[0].feature.length;
    const now = Date.now();

    const perCluster = new Map();

    for (const k of Object.keys(userBehavior || {})) {
      const i = this.keyToIndex[k];
      if (i === undefined) continue;
      const label = this.labels[i];
      if (label === undefined || label === null) continue;

      const meta = userBehavior[k] || {};
      const w = this.getInteractionWeight(meta, now);
      if (w <= 0) continue;

      if (!perCluster.has(label)) {
        perCluster.set(label, { label, weight: 0, vector: new Array(dim).fill(0) });
      }
      const bucket = perCluster.get(label);
      bucket.weight += w;
      const feat = idx[i].feature;
      for (let j = 0; j < dim; j++) bucket.vector[j] += (feat[j] || 0) * w;
    }

    const clusters = Array.from(perCluster.values())
      .filter(c => c.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, Math.max(1, maxInterests));

    for (const c of clusters) {
      for (let j = 0; j < c.vector.length; j++) c.vector[j] /= c.weight;
    }

    return clusters;
  }

  getPopularityBoost(meta = {}) {
    const views = Number(meta.views || 0);
    return Math.log(views + 1) * 0.05;
  }

  getCategoryRecentCounts(recentKeys = []) {
    const counts = {};
    if (!Array.isArray(recentKeys) || !recentKeys.length) return counts;
    for (const key of recentKeys) {
      const parsed = parseCatalogKey(key);
      if (!parsed) continue;
      const { category } = parsed;
      counts[category] = (counts[category] || 0) + 1;
    }
    return counts;
  }

  getSkipPenalty(meta = {}) {
    const skips = Number(meta.skips || 0);
    return skips * 0.08;
  }

  pickClusterExploreCandidate(candidates = []) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    const byLabel = new Map();
    for (const item of candidates) {
      const i = this.keyToIndex[item.key];
      if (i === undefined) continue;
      const label = this.labels[i];
      if (label === undefined || label === null) continue;
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(item);
    }

    const labels = Array.from(byLabel.keys());
    if (!labels.length) return candidates[Math.floor(Math.random() * candidates.length)];

    const label = labels[Math.floor(Math.random() * labels.length)];
    const pool = byLabel.get(label) || [];
    if (!pool.length) return candidates[Math.floor(Math.random() * candidates.length)];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  getTrendScore(meta = {}, now = Date.now()) {
    const views = Number(meta.views || 0);
    const base = Math.log(views + 1);
    const lastSeenAt = Number(meta.lastSeenAt || 0);
    if (!lastSeenAt) return base;
    const ageMs = Math.max(0, now - lastSeenAt);
    const recency = Math.exp(-ageMs / TIME_DECAY_MS);
    return base + recency;
  }

  // Build index from fileMap { category: [files] }
  async buildIndex(fileMap) {
    const idx = [];
    for (const cat of Object.keys(fileMap)) {
      for (const file of fileMap[cat]) {
        const key = `${cat}/${file}`;
        const t = textVector(file, 64);
        const a = deterministicRandomVector(key + ':a', 8);
        const v = deterministicRandomVector(key + ':v', 8);
        const feature = concat(t, a, v);
        // normalize feature
        const norm = Math.sqrt(feature.reduce((s,x)=>s + (x||0)*(x||0), 0)) || 1.0;
        for (let i=0;i<feature.length;i++) feature[i] = (feature[i]||0)/norm;
        idx.push({ key, category: cat, file, feature });
      }
    }
    this.index = idx;
    this.keyToIndex = {};
    this.index.forEach((it, i) => { this.keyToIndex[it.key] = i; });

    const data = this.index.map(i => i.feature);
    const k = Math.max(2, Math.min(12, Math.floor(Math.sqrt(Math.max(1, data.length)))));
    const { labels, centroids } = kmeans(data, k);
    this.labels = labels;
    this.centroids = centroids;
  }

  // Recommend videos given userBehavior { key: { watchTime, likes? } }
  recommend(userBehavior = {}, recentSet = new Set(), limit = 12, recentKeys = []) {
    // Build a user profile vector from watched/liked items
    const idx = this.index;
    const dim = idx.length ? idx[0].feature.length : 0;
    const userKeys = Object.keys(userBehavior || {}).filter(k => this.keyToIndex[k] !== undefined);
    const interests = this.buildMultiInterestProfiles(userBehavior, 3);
    const recentClusterCounts = this.getRecentClusterCounts(recentKeys);
    const recentCategoryCounts = this.getCategoryRecentCounts(recentKeys);

    const scored = [];

    if (userKeys.length) {
      // user profile = weighted sum of features of items with weights = watchTime + 3*likes
      const profile = new Array(dim).fill(0);
      let totalWeight = 0;
      for (const k of userKeys) {
        const meta = userBehavior[k] || {};
        const weight = this.getInteractionWeight(meta);
        const i = this.keyToIndex[k];
        if (i === undefined) continue;
        const feat = idx[i].feature;
        for (let j=0;j<dim;j++) profile[j] += (feat[j]||0) * weight;
        totalWeight += weight;
      }
      if (totalWeight <= 0) totalWeight = 1;
      for (let j=0;j<dim;j++) profile[j] /= totalWeight;

      // score every candidate by cosine similarity to profile
      for (let i=0;i<idx.length;i++){
        const key = idx[i].key;
        if (recentSet.has(key)) continue;

        let relevance = cosSim(profile, idx[i].feature);
        if (interests.length) {
          let bestInterest = -Infinity;
          for (const interest of interests) {
            const s = cosSim(interest.vector, idx[i].feature);
            if (s > bestInterest) bestInterest = s;
          }
          if (bestInterest > -Infinity) relevance = bestInterest;
        }

        const label = this.labels[i];
        const clusterPenalty = (recentClusterCounts[label] || 0) * 0.15;
        const categoryPenalty = (recentCategoryCounts[idx[i].category] || 0) * 0.1;
        const popBoost = this.getPopularityBoost(userBehavior[key] || {});
        const skipPenalty = this.getSkipPenalty(userBehavior[key] || {});
        const sim = relevance + popBoost - clusterPenalty - categoryPenalty - skipPenalty;

        scored.push({i, key, sim, item: idx[i]});
      }

      // Exploration: occasionally start list with a random unseen candidate.
      const selected = [];
      const selectedKeys = new Set();
      if (scored.length && Math.random() < 0.1) {
        const exploreItem = this.pickClusterExploreCandidate(scored.map(s => s.item));
        let pick = null;
        if (exploreItem) {
          const pos = scored.findIndex(s => s.key === exploreItem.key);
          if (pos >= 0) pick = scored.splice(pos, 1)[0];
        }
        if (pick) {
          selected.push(pick);
          selectedKeys.add(pick.key);
        }
      }

      // apply simple MMR for diversity
      const lambda = 0.65;
      scored.sort((a,b)=>b.sim - a.sim);
      while (selected.length < limit && scored.length){
        // candidate with highest MMR score
        let bestIdx = -1, bestScore = -Infinity;
        for (let p=0;p<scored.length;p++){
          const cand = scored[p];
          if (selectedKeys.has(cand.key)) continue;
          // compute max similarity to already selected
          let maxSim = 0;
          for (const s of selected){ maxSim = Math.max(maxSim, cosSim(idx[cand.i].feature, idx[s.i].feature)); }
          const mmr = lambda * cand.sim - (1-lambda) * maxSim;
          if (mmr > bestScore){ bestScore = mmr; bestIdx = p; }
        }
        if (bestIdx === -1) break;
        const take = scored.splice(bestIdx,1)[0];
        selected.push(take); selectedKeys.add(take.key);
      }

      const recs = selected.map(s=>s.item).slice(0,limit);
      return recs.map(it=>({
        videoUrl: `/videos/${encodeURIComponent(it.category)}/${encodeURIComponent(it.file)}`,
        thumbnailUrl: `/videos/${encodeURIComponent(it.category)}/${encodeURIComponent(it.file.replace(/\.[^/.]+$/, '') + '.webp')}`,
        user: it.category,
        caption: it.file,
        song: ''
      }));
    }

    // Fallback cold-start: trending score from local views + recency.
    const now = Date.now();
    const out = this.index
      .filter(it => !recentSet.has(it.key))
      .map(it => ({
        item: it,
        trend: this.getTrendScore(userBehavior[it.key] || {}, now)
      }))
      .sort((a, b) => b.trend - a.trend)
      .slice(0, limit)
      .map(x => x.item);

    return out.map(it=>({
      videoUrl: `/videos/${encodeURIComponent(it.category)}/${encodeURIComponent(it.file)}`,
      thumbnailUrl: `/videos/${encodeURIComponent(it.category)}/${encodeURIComponent(it.file.replace(/\.[^/.]+$/, '') + '.webp')}`,
      user: it.category,
      caption: it.file,
      song: ''
    }));
  }

  buildUserProfile(userBehavior = {}) {
    const idx = this.index;
    if (!idx.length) return null;
    const dim = idx[0].feature.length;
    const userKeys = Object.keys(userBehavior || {}).filter(k => this.keyToIndex[k] !== undefined);
    if (!userKeys.length) return null;

    const profile = new Array(dim).fill(0);
    let totalWeight = 0;
    const now = Date.now();
    for (const k of userKeys) {
      const meta = userBehavior[k] || {};
      const weight = this.getInteractionWeight(meta, now);
      const i = this.keyToIndex[k];
      if (i === undefined) continue;
      const feat = idx[i].feature;
      for (let j = 0; j < dim; j++) profile[j] += (feat[j] || 0) * weight;
      totalWeight += weight;
    }
    if (totalWeight <= 0) return null;
    for (let j = 0; j < dim; j++) profile[j] /= totalWeight;
    return profile;
  }

  recommendNext({ lastKey, action, userBehavior = {}, recentSet = new Set(), recentKeys = [] } = {}) {
    const idx = this.index;
    if (!idx.length) return null;

    const hasLast = !!lastKey && this.keyToIndex[lastKey] !== undefined;
    const lastIndex = hasLast ? this.keyToIndex[lastKey] : -1;
    const lastItem = hasLast ? idx[lastIndex] : null;
    const lastLabel = (hasLast && Array.isArray(this.labels)) ? this.labels[lastIndex] : null;
    const profile = this.buildUserProfile(userBehavior);
    const interests = this.buildMultiInterestProfiles(userBehavior, 3);
    const recentClusterCounts = this.getRecentClusterCounts(recentKeys);
    const recentCategoryCounts = this.getCategoryRecentCounts(recentKeys);

    const isPositive = action === 'like' || action === 'watch' || action === 'complete';
    const isSkip = action === 'skip';

    let candidates = [];
    for (let i = 0; i < idx.length; i++) {
      const item = idx[i];
      if (recentSet.has(item.key)) continue;
      if (item.key === lastKey) continue;

      if (hasLast && lastLabel !== null) {
        const label = this.labels[i];
        if (isPositive && label !== lastLabel) continue;
        if (isSkip && label === lastLabel) continue;
      }

      candidates.push(item);
    }

    if (!candidates.length) {
      for (const item of idx) {
        if (recentSet.has(item.key)) continue;
        if (item.key === lastKey) continue;
        candidates.push(item);
      }
    }

    if (!candidates.length) return null;

    // Exploration path to prevent recommendation stagnation.
    if (Math.random() < 0.1) {
      const explore = this.pickClusterExploreCandidate(candidates);
      return explore || candidates[Math.floor(Math.random() * candidates.length)];
    }

    let best = null;
    let bestScore = -Infinity;
    for (const item of candidates) {
      let score = 0;
      if (hasLast) {
        const simLast = cosSim(lastItem.feature, item.feature);
        score += isSkip ? (1 - simLast) : simLast;
      }
      if (profile) {
        const simProfile = cosSim(profile, item.feature);
        score += 0.35 * simProfile;
      }

      if (interests.length) {
        let bestInterest = -Infinity;
        for (const interest of interests) {
          const s = cosSim(interest.vector, item.feature);
          if (s > bestInterest) bestInterest = s;
        }
        if (bestInterest > -Infinity) score += 0.25 * bestInterest;
      }

      const label = this.labels[this.keyToIndex[item.key]];
      const clusterPenalty = (recentClusterCounts[label] || 0) * 0.15;
      const categoryPenalty = (recentCategoryCounts[item.category] || 0) * 0.1;
      score -= clusterPenalty;
      score -= categoryPenalty;
      score -= this.getSkipPenalty(userBehavior[item.key] || {});
      score += this.getPopularityBoost(userBehavior[item.key] || {});

      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    return best || candidates[0];
  }
}

module.exports = new Recommender();
