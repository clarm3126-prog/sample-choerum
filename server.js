require("dotenv").config();
const express = require("express");
const path = require("path");
const gplay = require("google-play-scraper");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const METRICS_CACHE_TTL_MS = Math.max(60_000, toNumber(process.env.METRICS_CACHE_TTL_MS) || 15 * 60 * 1000);
const DETAIL_CONCURRENCY = Math.max(1, Math.min(10, toNumber(process.env.DETAIL_CONCURRENCY) || 4));
const COMPARE_KEYWORD_LIMIT = 5;
const CATEGORY_KEYWORD_CACHE_TTL_MS = Math.max(60_000, toNumber(process.env.CATEGORY_KEYWORD_CACHE_TTL_MS) || 30 * 60 * 1000);
const metricsCache = new Map();
const metricsInflight = new Map();
const categoryKeywordCache = new Map();

const CATEGORY_KEYWORD_SEEDS = {
  health: {
    searchTerm: "건강 관리 앱",
    keywords: ["건강 관리 앱", "홈트레이닝 앱", "수면 관리 앱", "명상 앱", "식단 기록 앱", "만보기 앱"],
  },
  finance: {
    searchTerm: "가계부 앱",
    keywords: ["가계부 앱", "예산 관리 앱", "주식 투자 앱", "환율 계산기 앱", "가상자산 시세 앱", "소비 분석 앱"],
  },
  productivity: {
    searchTerm: "할 일 관리 앱",
    keywords: ["할 일 관리 앱", "노트 필기 앱", "캘린더 일정 앱", "집중 타이머 앱", "문서 스캔 앱", "루틴 관리 앱"],
  },
  education: {
    searchTerm: "영어 공부 앱",
    keywords: ["영어 공부 앱", "단어 암기 앱", "코딩 학습 앱", "수학 문제 풀이 앱", "유아 학습 앱", "토익 학습 앱"],
  },
  lifestyle: {
    searchTerm: "다이어트 앱",
    keywords: ["다이어트 앱", "레시피 앱", "패션 코디 앱", "집 꾸미기 앱", "반려동물 관리 앱", "운세 앱"],
  },
  entertainment: {
    searchTerm: "동영상 편집 앱",
    keywords: ["동영상 편집 앱", "음악 스트리밍 앱", "웹툰 앱", "짧은 영상 앱", "사진 보정 앱", "OTT 추천 앱"],
  },
  business: {
    searchTerm: "업무 관리 앱",
    keywords: ["업무 관리 앱", "재고 관리 앱", "전자결재 앱", "매출 분석 앱", "고객 관리 CRM 앱", "근태 관리 앱"],
  },
  social: {
    searchTerm: "커뮤니티 앱",
    keywords: ["커뮤니티 앱", "익명 게시판 앱", "동네 소통 앱", "관심사 모임 앱", "실시간 채팅 앱", "팬 커뮤니티 앱"],
  },
};

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "appsourcer", timestamp: new Date().toISOString() });
});
function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function formatPercent(numerator, denominator) {
  if (!denominator) return "0.00%";
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function confidenceLabelFromScore(score) {
  if (score >= 75) return "HIGH";
  if (score >= 55) return "MEDIUM";
  return "LOW";
}

function buildMarketMetrics(keyword, searchData, appDetails) {
  const apps = searchData?.apps || [];
  const details = appDetails || [];

  const avgScore =
    apps.length > 0
      ? (
          apps.reduce((sum, item) => sum + toNumber(item.score), 0) / apps.length
        ).toFixed(2)
      : "0.00";

  const iapCount = details.filter((item) => item.offers_iap).length;
  const adCount = details.filter((item) => item.ad_supported).length;
  const withDetailCount = details.length;

  let negNumerator = 0;
  let negDenominator = 0;
  let revenueLowTotal = 0;
  let revenueHighTotal = 0;
  let revenueP25Total = 0;
  let revenueP50Total = 0;
  let revenueP75Total = 0;
  let confidenceSum = 0;
  const categoryCounter = {};

  const topCompetitors = details.map((item) => {
    negNumerator += toNumber(item.histogram?.[1]) + toNumber(item.histogram?.[2]);
    negDenominator += toNumber(item.ratings);

    const revenue = estimateMonthlyRevenue(item, keyword);
    revenueLowTotal += revenue.low;
    revenueHighTotal += revenue.high;
    revenueP25Total += revenue.p25;
    revenueP50Total += revenue.p50;
    revenueP75Total += revenue.p75;
    confidenceSum += revenue.confidenceScore;
    categoryCounter[revenue.category] = (categoryCounter[revenue.category] || 0) + 1;

    return {
      appId: item.appId,
      title: item.title,
      developer: item.developer,
      score: item.score,
      ratings: item.ratings || 0,
      installs: item.installs,
      offersIAP: item.offers_iap,
      adSupported: item.ad_supported,
      negativeReviewRate: item.neg_rate,
      estimatedRevenueLow: revenue.lowLabel,
      estimatedRevenueHigh: revenue.highLabel,
      estimatedRevenueP25: revenue.p25Label,
      estimatedRevenueP50: revenue.p50Label,
      estimatedRevenueP75: revenue.p75Label,
      estimatedRevenueRange: revenue.rangeLabel,
      revenueConfidenceScore: revenue.confidenceScore,
      revenueConfidenceLabel: revenue.confidenceLabel,
      revenueModelCategory: revenue.category,
    };
  });

  const assumptions = estimateMonthlyRevenue({
    offers_iap: true,
    ad_supported: true,
    installs: "100000+",
  }, keyword).assumptions;
  const avgConfidence = withDetailCount > 0 ? confidenceSum / withDetailCount : 50;
  const confidenceLabel = confidenceLabelFromScore(avgConfidence);

  return {
    keyword,
    generatedAt: new Date().toISOString(),
    averageRating: avgScore,
    competitorCount: apps.length,
    analyzedAppsCount: withDetailCount,
    negativeReviewRate: formatPercent(negNumerator, negDenominator),
    iapRatio: formatPercent(iapCount, withDetailCount),
    adSupportedRatio: formatPercent(adCount, withDetailCount),
    estimatedMonthlyRevenueTotalLow: formatKRW(revenueLowTotal),
    estimatedMonthlyRevenueTotalHigh: formatKRW(revenueHighTotal),
    estimatedMonthlyRevenueTotalP25: formatKRW(revenueP25Total),
    estimatedMonthlyRevenueTotalP50: formatKRW(revenueP50Total),
    estimatedMonthlyRevenueTotalP75: formatKRW(revenueP75Total),
    estimatedMonthlyRevenueTotalRange: `${formatKRW(revenueLowTotal)} ~ ${formatKRW(revenueHighTotal)}`,
    revenueConfidenceScore: Number(avgConfidence.toFixed(1)),
    revenueConfidenceLabel: confidenceLabel,
    revenueCategoryMix: categoryCounter,
    revenueEstimateAssumptions: assumptions,
    topCompetitors,
  };
}

function normalizeKeyword(keyword) {
  return String(keyword || "").trim();
}

function cacheKeyForMetrics(keyword, searchSize, detailSize) {
  return `${normalizeKeyword(keyword).toLowerCase()}|${searchSize}|${detailSize}`;
}

function normalizeCategoryId(value) {
  return String(value || "").trim().toLowerCase();
}

function getCategorySeed(categoryId) {
  return CATEGORY_KEYWORD_SEEDS[normalizeCategoryId(categoryId)] || null;
}

function defaultCategoryKeywords(categoryId, limit = 10) {
  const seed = getCategorySeed(categoryId);
  if (!seed) return [];
  return [...new Set(seed.keywords.filter(Boolean))].slice(0, limit);
}

function readCategoryKeywordCache(categoryId) {
  const key = normalizeCategoryId(categoryId);
  const hit = categoryKeywordCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    categoryKeywordCache.delete(key);
    return null;
  }
  return hit.data;
}

function extractKeywordCandidatesFromTitle(title) {
  return String(title || "")
    .replace(/[()\[\]{}]/g, " ")
    .split(/[|·:,+/\\\-]/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && part.length <= 24)
    .filter((part) => !/^(앱|무료|pro|premium|new|official)$/i.test(part))
    .map((part) => part.replace(/\s+/g, " "));
}

async function buildCategoryKeywords(categoryId, limit = 10, forceRefresh = false) {
  const normalized = normalizeCategoryId(categoryId);
  const seed = getCategorySeed(normalized);
  if (!seed) return { category: normalized, keywords: [], cacheStatus: "none", source: "seed" };

  if (!forceRefresh) {
    const cached = readCategoryKeywordCache(normalized);
    if (cached) return { ...cached, cacheStatus: "hit" };
  }

  const fallback = defaultCategoryKeywords(normalized, limit);
  try {
    const searchResults = await gplay.search({
      term: seed.searchTerm,
      lang: "ko",
      country: "kr",
      num: 24,
    });

    const merged = [...fallback];
    searchResults.forEach((appLike) => {
      extractKeywordCandidatesFromTitle(appLike?.title).forEach((candidate) => merged.push(candidate));
    });

    const keywords = [...new Set(merged.map((v) => String(v).trim()).filter(Boolean))].slice(0, limit);
    const data = {
      category: normalized,
      keywords,
      source: "live",
      generatedAt: new Date().toISOString(),
    };
    categoryKeywordCache.set(normalized, { data, expiresAt: Date.now() + CATEGORY_KEYWORD_CACHE_TTL_MS });
    return { ...data, cacheStatus: forceRefresh ? "refresh" : "miss" };
  } catch (_err) {
    const data = {
      category: normalized,
      keywords: fallback,
      source: "seed",
      generatedAt: new Date().toISOString(),
    };
    categoryKeywordCache.set(normalized, { data, expiresAt: Date.now() + CATEGORY_KEYWORD_CACHE_TTL_MS });
    return { ...data, cacheStatus: "fallback" };
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function buildMetricsFromSource(keyword, searchSize, detailSize) {
  const searchResults = await gplay.search({
    term: keyword,
    num: searchSize,
    lang: "ko",
    country: "kr",
    fullDetail: false,
  });

  const topApps = (searchResults || []).slice(0, detailSize);
  const detailResults = await mapWithConcurrency(topApps, DETAIL_CONCURRENCY, async (appInfo) => {
    try {
      const detail = await gplay.app({
        appId: appInfo.appId,
        lang: "ko",
        country: "kr",
      });

      const histogram = detail.histogram || {};
      const ratings = toNumber(detail.ratings);
      return {
        appId: detail.appId,
        title: detail.title,
        developer: detail.developer,
        score: detail.score,
        ratings: detail.ratings,
        histogram: detail.histogram,
        genre: detail.genre,
        installs: detail.installs,
        minInstalls: detail.minInstalls,
        maxInstalls: detail.maxInstalls,
        offers_iap: detail.offersIAP,
        ad_supported: detail.adSupported,
        updated: detail.updated,
        neg_rate: formatPercent(toNumber(histogram[1]) + toNumber(histogram[2]), ratings),
      };
    } catch (_innerErr) {
      return null;
    }
  });

  const appDetails = detailResults.filter(Boolean);
  const searchData = {
    apps: (searchResults || []).map((item) => ({
      appId: item.appId,
      score: item.score,
    })),
  };

  return buildMarketMetrics(keyword, searchData, appDetails);
}

function readCachedMetrics(key) {
  const hit = metricsCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    metricsCache.delete(key);
    return null;
  }
  return hit.data;
}

async function getMetricsWithCache(keyword, searchSize, detailSize, options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const key = cacheKeyForMetrics(keyword, searchSize, detailSize);

  if (!forceRefresh) {
    const cached = readCachedMetrics(key);
    if (cached) {
      return { metrics: cached, cacheStatus: "hit" };
    }
  }

  if (!forceRefresh && metricsInflight.has(key)) {
    const data = await metricsInflight.get(key);
    return { metrics: data, cacheStatus: "inflight" };
  }

  const pending = buildMetricsFromSource(keyword, searchSize, detailSize)
    .then((data) => {
      metricsCache.set(key, { data, expiresAt: Date.now() + METRICS_CACHE_TTL_MS });
      return data;
    })
    .finally(() => {
      metricsInflight.delete(key);
    });

  metricsInflight.set(key, pending);
  const metrics = await pending;
  return { metrics, cacheStatus: forceRefresh ? "refresh" : "miss" };
}

app.get("/api/search", async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.status(400).json({ error: "keyword 필요" });

  try {
    const results = await gplay.search({
      term: keyword,
      num: 20,
      lang: "ko",
      country: "kr",
      fullDetail: false,
    });

    res.json({
      keyword,
      apps: results.map((item) => ({
        appId: item.appId,
        title: item.title,
        developer: item.developer,
        icon: item.icon,
        score: item.score,
        reviews: item.reviews,
        installs: item.installs,
        free: item.free,
        genre: item.genre,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/app", async (req, res) => {
  const { appId } = req.query;
  if (!appId) return res.status(400).json({ error: "appId 필요" });

  try {
    const [detail, reviewsData] = await Promise.all([
      gplay.app({ appId, lang: "ko", country: "kr" }),
      gplay.reviews({
        appId,
        lang: "ko",
        country: "kr",
        sort: gplay.sort.NEWEST,
        num: 100,
      }),
    ]);

    const histogram = detail.histogram || {};
    const totalRatings = detail.ratings || 1;
    const negRate = ((((histogram[1] || 0) + (histogram[2] || 0)) / totalRatings) * 100).toFixed(2);

    res.json({
      appId,
      title: detail.title,
      developer: detail.developer,
      score: detail.score,
      ratings: detail.ratings,
      histogram: detail.histogram,
      neg_rate: `${negRate}%`,
      installs: detail.installs,
      free: detail.free,
      offers_iap: detail.offersIAP,
      iap_range: detail.inAppProductPrice,
      ad_supported: detail.adSupported,
      released: detail.released,
      updated: detail.updated,
      negative_reviews: reviewsData.data
        .filter((r) => r.score <= 2)
        .slice(0, 15)
        .map((r) => ({ score: r.score, text: r.text, date: r.date })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/metrics", async (req, res) => {
  const keyword = normalizeKeyword(req.query.keyword);
  if (!keyword) return res.status(400).json({ error: "keyword 필요" });

  const searchSize = Math.max(5, Math.min(50, toNumber(req.query.searchSize) || 20));
  const detailSize = Math.max(3, Math.min(20, toNumber(req.query.detailSize) || 20));
  const forceRefresh = req.query.refresh === "1";

  try {
    const result = await getMetricsWithCache(keyword, searchSize, detailSize, { forceRefresh });
    res.setHeader("X-Cache", result.cacheStatus);
    return res.json({
      metrics: result.metrics,
      meta: {
        cacheStatus: result.cacheStatus,
        ttlMs: METRICS_CACHE_TTL_MS,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/compare", async (req, res) => {
  const raw = String(req.query.keywords || "");
  const keywords = raw
    .split(",")
    .map((value) => normalizeKeyword(value))
    .filter(Boolean)
    .slice(0, COMPARE_KEYWORD_LIMIT);

  if (keywords.length < 2) {
    return res.status(400).json({ error: "비교를 위해 키워드 2개 이상이 필요합니다" });
  }

  const searchSize = Math.max(5, Math.min(50, toNumber(req.query.searchSize) || 30));
  const detailSize = Math.max(3, Math.min(20, toNumber(req.query.detailSize) || 20));
  const keywordConcurrency = Math.max(1, Math.min(3, toNumber(req.query.keywordConcurrency) || 2));
  const forceRefresh = req.query.refresh === "1";

  try {
    const rows = await mapWithConcurrency(keywords, keywordConcurrency, async (keyword) => {
      const result = await getMetricsWithCache(keyword, searchSize, detailSize, { forceRefresh });
      const metrics = result.metrics;
      return {
        keyword,
        averageRating: metrics.averageRating,
        competitorCount: metrics.competitorCount,
        negativeReviewRate: metrics.negativeReviewRate,
        iapRatio: metrics.iapRatio,
        adSupportedRatio: metrics.adSupportedRatio,
        estimatedMonthlyRevenueTotalRange: metrics.estimatedMonthlyRevenueTotalRange,
        estimatedMonthlyRevenueTotalP50: metrics.estimatedMonthlyRevenueTotalP50,
        revenueConfidenceScore: metrics.revenueConfidenceScore,
        revenueConfidenceLabel: metrics.revenueConfidenceLabel,
        cacheStatus: result.cacheStatus,
      };
    });

    return res.json({
      generatedAt: new Date().toISOString(),
      rows,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/category-keywords", async (req, res) => {
  const category = normalizeCategoryId(req.query.category);
  if (!category) return res.status(400).json({ error: "category 필요" });

  const limit = Math.max(3, Math.min(20, toNumber(req.query.limit) || 10));
  const forceRefresh = req.query.refresh === "1";

  const seedExists = !!getCategorySeed(category);
  if (!seedExists) {
    return res.status(404).json({ error: "지원하지 않는 category 입니다" });
  }

  try {
    const payload = await buildCategoryKeywords(category, limit, forceRefresh);
    return res.json({
      ...payload,
      ttlMs: CATEGORY_KEYWORD_CACHE_TTL_MS,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  const { keyword, searchData, appDetails } = req.body;
  if (!keyword) return res.status(400).json({ error: "keyword 필요" });

  const avgScore = searchData?.apps?.length
    ? (
        searchData.apps.reduce((sum, a) => sum + (a.score || 0), 0) / searchData.apps.length
      ).toFixed(1)
    : "N/A";

  const realData = `
=== 실제 Google Play 수집 데이터 ===
키워드: "${keyword}"
검색결과 앱 수: ${searchData?.apps?.length || 0}개
상위 앱 평균 평점: ${avgScore}

[상위 앱 목록]
${(searchData?.apps || [])
  .slice(0, 20)
  .map(
    (a, i) =>
      `${i + 1}. "${a.title}" (${a.developer}) | 평점:${a.score} | 리뷰:${(a.reviews || 0).toLocaleString()}개 | 설치:${a.installs} | 무료:${a.free}`,
  )
  .join("\n")}

[앱 상세 데이터]
${(appDetails || [])
  .map(
    (a) => `
■ ${a.title} (${a.developer})
  - 평점: ${a.score} / 총 평가: ${(a.ratings || 0).toLocaleString()}명
  - 별점분포: 1★${a.histogram?.[1] || 0} / 2★${a.histogram?.[2] || 0} / 5★${a.histogram?.[5] || 0}
  - 부정리뷰 비율: ${a.neg_rate}
  - 설치수: ${a.installs}
  - 광고: ${a.ad_supported ? "있음" : "없음"} | IAP: ${a.offers_iap ? a.iap_range || "있음" : "없음"}
  - 출시: ${a.released} | 최근업데이트: ${a.updated}
  - 실제 부정리뷰:
${(a.negative_reviews || [])
  .slice(0, 4)
  .map((r) => `    [${r.score}★] "${r.text?.slice(0, 100)}"`)
  .join("\n")}
`,
  )
  .join("")}`;

  const prompt = `당신은 앱 시장 전문 분석가입니다. 아래 Google Play 실제 데이터를 기반으로 분석 리포트를 JSON으로 생성하세요.

${realData}

JSON만 출력하고 다른 텍스트는 절대 포함하지 마세요.

{
  "keywords": {
    "mainTraffic": "실제 검색결과 수",
    "popularity": "0~100 경쟁강도",
    "competitorCount": "실제 앱 수",
    "adMarket": "[추정] ₩XXX만",
    "avgRating": "실제 평균 평점",
    "seasonality": "계절성 추정",
    "keywords": [
      { "keyword": "메인키워드", "traffic": "실제값", "popularity": "실제값", "apps": "실제값", "cpc": "[추정] ₩XXX", "adMarket": "[추정] ₩XXX만" },
      { "keyword": "파생키워드1", "traffic": "[추정]", "popularity": "[추정]", "apps": "[추정]", "cpc": "[추정]", "adMarket": "[추정]" },
      { "keyword": "파생키워드2", "traffic": "[추정]", "popularity": "[추정]", "apps": "[추정]", "cpc": "[추정]", "adMarket": "[추정]" }
    ]
  },
  "competitors": {
    "topRevenue": "[추정]",
    "indieRevenue": "[추정]",
    "monetizedRatio": "실제 IAP 비율",
    "insight": "실제 데이터 기반 인사이트",
    "apps": [
      { "name": "실제앱명", "developer": "실제개발사", "age": "출시연도기반", "rating": "실제평점", "dailyDL": "[추정]", "revenue": "[추정]$XXX", "model": "IAP/광고여부기반", "negRate": "실제부정리뷰비율" }
    ]
  },
  "reviews": {
    "patterns": [
      { "pattern": "실제부정리뷰패턴", "count": 숫자, "quote": "실제리뷰텍스트", "solution": "해결책" }
    ]
  },
  "subscription": {
    "conditions": [
      { "label": "데이터 누적형", "status": "O", "reason": "string" },
      { "label": "매일 반복 사용", "status": "△", "reason": "string" },
      { "label": "서버 비용 정당성", "status": "X", "reason": "string" },
      { "label": "개인화 가치", "status": "O", "reason": "string" }
    ],
    "plans": [
      { "label": "주간", "price": "₩1,900" },
      { "label": "월간", "price": "₩4,900" },
      { "label": "연간", "price": "₩39,900" },
      { "label": "평생", "price": "₩79,900" }
    ],
    "verdict": "string"
  },
  "scoring": {
    "total": 숫자,
    "items": [
      { "label": "검색 수요", "score": 숫자, "max": 20 },
      { "label": "경쟁 강도", "score": 숫자, "max": 15 },
      { "label": "1★ 비율", "score": 숫자, "max": 5 },
      { "label": "시장 매출 검증", "score": 숫자, "max": 5 },
      { "label": "구독 적합성", "score": 숫자, "max": 15 },
      { "label": "반복 사용", "score": 숫자, "max": 10 },
      { "label": "개발 복잡도", "score": 숫자, "max": 10 },
      { "label": "차별점 명확성", "score": 숫자, "max": 20 }
    ],
    "coreReason": "실제 데이터 기반 핵심 근거"
  },
  "mvp": {
    "differentiator": "실제 부정리뷰 기반 차별점",
    "appNames": ["ASO앱이름1", "앱이름2", "앱이름3"],
    "roadmap": [
      { "period": "1주차", "tasks": "string" },
      { "period": "2주차", "tasks": "string" }
    ]
  },
  "recommendations": {
    "apps": [
      {
        "name": "string",
        "tier": "Tier 1|Tier 2|Tier 3",
        "revenueModel": "구독|하이브리드|일회성구매",
        "target": "string",
        "estimatedRevenue": "₩XX만~₩XX만",
        "differentiator": "string",
        "features": ["string", "string", "string"],
        "risk": "string"
      }
    ]
  }
}`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content.map((b) => b.text || "").join("");
    const clean = text.replace(/```json|```/g, "").trim();
    const report = JSON.parse(clean);
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ◈ AppSourcer 실행 중!");
  console.log(`  ▶ 크롬에서 열기: http://localhost:${PORT}`);
  console.log("  ■ 종료하려면: Ctrl + C");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});

const CATEGORY_PROFILES = {
  finance: {
    label: "Finance",
    installMaxMultiplier: 2.4,
    activeUserRate: [0.03, 0.09],
    iapConversionRate: [0.01, 0.028],
    iapARPPU: [11000, 26000],
    adImpressionsPerUser: [15, 45],
    adECPM: [2200, 6500],
    confidenceBase: 72,
  },
  productivity: {
    label: "Productivity",
    installMaxMultiplier: 2.6,
    activeUserRate: [0.025, 0.085],
    iapConversionRate: [0.009, 0.023],
    iapARPPU: [9500, 22000],
    adImpressionsPerUser: [18, 52],
    adECPM: [1900, 5600],
    confidenceBase: 68,
  },
  health: {
    label: "Health/Wellness",
    installMaxMultiplier: 2.8,
    activeUserRate: [0.02, 0.075],
    iapConversionRate: [0.008, 0.02],
    iapARPPU: [9000, 21000],
    adImpressionsPerUser: [20, 60],
    adECPM: [1800, 5200],
    confidenceBase: 64,
  },
  education: {
    label: "Education",
    installMaxMultiplier: 2.7,
    activeUserRate: [0.02, 0.08],
    iapConversionRate: [0.007, 0.02],
    iapARPPU: [8500, 20000],
    adImpressionsPerUser: [20, 55],
    adECPM: [1800, 5000],
    confidenceBase: 62,
  },
  entertainment: {
    label: "Entertainment",
    installMaxMultiplier: 3.1,
    activeUserRate: [0.018, 0.07],
    iapConversionRate: [0.006, 0.018],
    iapARPPU: [8000, 18000],
    adImpressionsPerUser: [30, 90],
    adECPM: [1600, 4600],
    confidenceBase: 58,
  },
  general: {
    label: "General",
    installMaxMultiplier: 2.7,
    activeUserRate: [0.02, 0.08],
    iapConversionRate: [0.008, 0.025],
    iapARPPU: [9000, 23000],
    adImpressionsPerUser: [20, 60],
    adECPM: [2000, 6000],
    confidenceBase: 60,
  },
};

function inferRevenueCategory(detailLike, keyword) {
  const source = `${detailLike?.genre || ""} ${detailLike?.title || ""} ${keyword || ""}`.toLowerCase();

  if (/(가계부|금융|핀테크|투자|budget|money|finance|bank|expense)/.test(source)) return "finance";
  if (/(할 일|todo|생산성|업무|메모|calendar|task|productivity|saas)/.test(source)) return "productivity";
  if (/(건강|헬스|수면|다이어트|wellness|health|fitness|meditation)/.test(source)) return "health";
  if (/(교육|공부|학습|영어|education|learning|edtech)/.test(source)) return "education";
  if (/(엔터|동영상|music|video|game|entertainment|stream)/.test(source)) return "entertainment";
  return "general";
}

function parseInstallsBounds(detail, profile) {
  const directMin = toNumber(detail?.minInstalls);
  const directMax = toNumber(detail?.maxInstalls);
  if (directMin > 0 && directMax >= directMin) {
    return { min: directMin, max: directMax };
  }

  const raw = String(detail?.installs || "");
  const num = toNumber(raw.replace(/[^0-9]/g, ""));
  if (num > 0) {
    const multiplier = profile?.installMaxMultiplier || 2.7;
    return { min: num, max: Math.max(num, Math.floor(num * multiplier)) };
  }

  return { min: 0, max: 0 };
}

function formatKRW(value) {
  return `KRW ${Math.round(value).toLocaleString("en-US")}`;
}

function toPercentNumber(value) {
  if (typeof value === "string") {
    return toNumber(value.replace("%", ""));
  }
  return toNumber(value);
}

function computeQualityConfidence(detailLike) {
  const rating = clamp(toNumber(detailLike?.score), 0, 5);
  const ratingScore = clamp((rating - 3.4) / 1.6, 0, 1);

  const ratingsCount = Math.max(0, toNumber(detailLike?.ratings));
  const volumeScore = clamp(Math.log10(ratingsCount + 1) / 6, 0, 1);

  const negRate = toPercentNumber(detailLike?.neg_rate);
  const negScore = clamp(1 - negRate / 18, 0, 1);

  const updatedAt = new Date(detailLike?.updated || 0);
  const daysSinceUpdate = Number.isFinite(updatedAt.getTime())
    ? (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24)
    : 365;
  const freshnessScore = clamp(1 - daysSinceUpdate / 540, 0, 1);

  return clamp((ratingScore * 0.33) + (volumeScore * 0.24) + (negScore * 0.28) + (freshnessScore * 0.15), 0, 1);
}

function interpolate(low, high, ratio) {
  return low + ((high - low) * ratio);
}

function estimateMonthlyRevenue(detailLike, keyword = "") {
  const category = inferRevenueCategory(detailLike, keyword);
  const profile = CATEGORY_PROFILES[category] || CATEGORY_PROFILES.general;
  const installs = parseInstallsBounds(detailLike, profile);
  const qualityConfidence = computeQualityConfidence(detailLike);
  const usageBias = 0.85 + (qualityConfidence * 0.3);

  const minActive = installs.min * profile.activeUserRate[0] * usageBias;
  const maxActive = installs.max * profile.activeUserRate[1] * usageBias;

  let low = 0;
  let high = 0;

  if (detailLike?.offers_iap) {
    const lowPaidUsers = minActive * profile.iapConversionRate[0];
    const highPaidUsers = maxActive * profile.iapConversionRate[1];
    low += lowPaidUsers * profile.iapARPPU[0];
    high += highPaidUsers * profile.iapARPPU[1];
  }

  if (detailLike?.ad_supported) {
    const lowImpressions = minActive * profile.adImpressionsPerUser[0];
    const highImpressions = maxActive * profile.adImpressionsPerUser[1];
    low += (lowImpressions / 1000) * profile.adECPM[0];
    high += (highImpressions / 1000) * profile.adECPM[1];
  }

  const p25 = interpolate(low, high, 0.25);
  const p50 = interpolate(low, high, 0.5);
  const p75 = interpolate(low, high, 0.75);
  const confidenceScore = clamp((profile.confidenceBase * 0.55) + (qualityConfidence * 100 * 0.45), 35, 95);
  const confidenceLabel = confidenceLabelFromScore(confidenceScore);

  return {
    category,
    low,
    high,
    p25,
    p50,
    p75,
    confidenceScore: Number(confidenceScore.toFixed(1)),
    confidenceLabel,
    lowLabel: formatKRW(low),
    highLabel: formatKRW(high),
    p25Label: formatKRW(p25),
    p50Label: formatKRW(p50),
    p75Label: formatKRW(p75),
    rangeLabel: `${formatKRW(low)} ~ ${formatKRW(high)}`,
    assumptions: {
      revenueCategory: profile.label,
      activeUserRate: `${(profile.activeUserRate[0] * 100).toFixed(1)}% ~ ${(profile.activeUserRate[1] * 100).toFixed(1)}%`,
      iapConversionRate: `${(profile.iapConversionRate[0] * 100).toFixed(1)}% ~ ${(profile.iapConversionRate[1] * 100).toFixed(1)}%`,
      iapARPPU: `KRW ${profile.iapARPPU[0].toLocaleString("en-US")} ~ ${profile.iapARPPU[1].toLocaleString("en-US")}/month`,
      adImpressionsPerUser: `${profile.adImpressionsPerUser[0]} ~ ${profile.adImpressionsPerUser[1]} per month`,
      adECPM: `KRW ${profile.adECPM[0].toLocaleString("en-US")} ~ ${profile.adECPM[1].toLocaleString("en-US")}`,
      confidenceScore: `${Number(confidenceScore.toFixed(1))} (${confidenceLabel})`,
    },
  };
}
