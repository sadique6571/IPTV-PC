'use strict';

const languages = /[\[(]\s*(hindi|हिंदी|हिन्दी|english|urdu|punjabi|tamil|telugu|malayalam|kannada|bengali|korean|chinese|japanese|spanish|french)(?:\s+(?:dubbed|dub))?\s*[\])]/giu;
const hindiSuffix = /(?:\s*[-–·:]\s*hindi(?:\s+(?:dubbed|dub))?|\s+hindi\s+(?:dubbed|dub))$/i;
const hindiName = /^(hindi(?: dubbed| dub)?|hi|hin|हिंदी|हिन्दी)$/iu;
const articles = new Set(['a', 'an', 'the']);
const CLOSE_MATCH = 3;

function hasHindiAudio(subject, title) {
  const declared = ['audioLanguage', 'language', 'lanName'].flatMap(key =>
    Array.isArray(subject[key]) ? subject[key] : String(subject[key] || '').split(','));
  return declared.some(value => hindiName.test(String(value).trim())) ||
    [...title.matchAll(languages)].some(match => hindiName.test(match[1])) || hindiSuffix.test(title);
}

function stripLanguage(value) { return value.replace(languages, ' ').trim().replace(hindiSuffix, '').trim(); }
function searchTerm(value) { return stripLanguage(value).replace(/\s+hindi(?:\s+(?:dubbed|dub))?$/i, '').trim() || value.trim(); }
function words(value) {
  const tokens = stripLanguage(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [];
  const relevant = tokens.filter(token => !articles.has(token));
  return relevant.length ? relevant : tokens;
}

function similarWord(query, title) {
  if (query === title) return true;
  if (query.length < 4 || title.length < 4) return false;
  if (query.length >= 5 && title.startsWith(query)) return true;
  if (query.length === title.length) {
    const differences = [...query].map((_, i) => i).filter(i => query[i] !== title[i]);
    const [a, b] = differences;
    return differences.length === 1 || differences.length === 2 && b === a + 1 &&
      query[a] === title[b] && query[b] === title[a];
  }
  if (Math.abs(query.length - title.length) !== 1) return false;
  const [shorter, longer] = query.length < title.length ? [query, title] : [title, query];
  let index = 0;
  while (index < shorter.length && shorter[index] === longer[index]) index++;
  return shorter.slice(index) === longer.slice(index + 1);
}

function matcher(query) {
  const queryWords = words(searchTerm(query));
  const phrase = queryWords.join(' ');
  function relevance(value) {
    if (!phrase) return 0;
    const title = words(value);
    const titlePhrase = title.join(' ');
    if (titlePhrase === phrase) return 5;
    if ((' ' + titlePhrase + ' ').includes(' ' + phrase + ' ')) return 4;
    const matches = queryWords.filter(word => title.some(token => similarWord(word, token))).length;
    if (matches === queryWords.length) return CLOSE_MATCH;
    return matches * 2 >= queryWords.length && queryWords.some(word => word.length >= 4 && title.includes(word)) ? 2 : 0;
  }
  const keywords = queryWords.filter(word => word.length >= 4).sort((a, b) => a.length - b.length);
  const longest = keywords.at(-1);
  const related = [...new Set([
    queryWords.length > 1 ? keywords[0] : null,
    longest?.slice(0, Math.max(3, longest.length - 2)),
  ].filter(Boolean))];
  function rank(movies) {
    const unique = new Map();
    for (const movie of movies) if (!unique.has(movie.subjectId)) unique.set(movie.subjectId, movie);
    return [...unique.values()].map(movie => ({ movie, score: relevance(movie.title) }))
      .sort((a, b) => b.score - a.score ||
        (a.score > 0 ? Number(Boolean(b.movie.isHindi)) - Number(Boolean(a.movie.isHindi)) : 0) ||
        (Number(b.movie.year) || 0) - (Number(a.movie.year) || 0) ||
        releaseDate(b.movie).localeCompare(releaseDate(a.movie)))
      .map(item => item.movie);
  }
  return { relevance, related, rank };
}

function releaseDate(movie) {
  return String(movie.releaseDate || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '';
}

async function searchTitles(query, known, fetchPage) {
  const term = searchTerm(query);
  const match = matcher(term);
  const local = known.filter(movie => match.relevance(movie.title) > 0);
  const remote = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const batch = await fetchPage(term, page);
      remote.push(...batch);
      if (batch.length < 15) break;
    } catch (error) {
      if (!remote.length && !local.length) throw error;
      break;
    }
  }
  async function supplement(text) {
    const items = await fetchPage(text, 1).catch(() => []);
    remote.push(...items.filter(movie => match.relevance(movie.title) > 0));
  }
  const hasClose = () => [...remote, ...local].some(movie => match.relevance(movie.title) >= CLOSE_MATCH);
  if (!hasClose()) {
    for (const fallback of match.related) {
      await supplement(fallback);
      if (hasClose()) break;
    }
  }
  const candidates = [...remote, ...local];
  const closest = match.rank(candidates)[0];
  const base = closest && match.relevance(closest.title) === CLOSE_MATCH ? searchTerm(closest.title) : term;
  if (base && base.toLowerCase() !== 'hindi' &&
      !candidates.some(movie => movie.isHindi && match.relevance(movie.title) >= CLOSE_MATCH)) {
    await supplement(base + ' Hindi');
  }
  return match.rank([...remote, ...local]);
}

module.exports = { hasHindiAudio, matcher, searchTitles };
