require("dotenv").config();
const express = require("express");
const path = require("path");
const gplay = require("google-play-scraper");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function formatPercent(numerator, denominator) {
  if (!denominator) return "0.00%";
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
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

  const topCompetitors = details.map((item) => {
    negNumerator += toNumber(item.histogram?.[1]) + toNumber(item.histogram?.[2]);
    negDenominator += toNumber(item.ratings);

    const revenue = estimateMonthlyRevenue(item);
    revenueLowTotal += revenue.low;
    revenueHighTotal += revenue.high;

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
      estimatedRevenueRange: revenue.rangeLabel,
    };
  });

  const assumptions = estimateMonthlyRevenue({
    offers_iap: true,
    ad_supported: true,
    installs: "100000+",
  }).assumptions;

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
    estimatedMonthlyRevenueTotalRange: `${formatKRW(revenueLowTotal)} ~ ${formatKRW(revenueHighTotal)}`,
    revenueEstimateAssumptions: assumptions,
    topCompetitors,
  };
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
  const { keyword } = req.query;
  if (!keyword) return res.status(400).json({ error: "keyword 필요" });

  const searchSize = Math.max(5, Math.min(50, toNumber(req.query.searchSize) || 20));
  const detailSize = Math.max(3, Math.min(20, toNumber(req.query.detailSize) || 10));

  try {
    const searchResults = await gplay.search({
      term: keyword,
      num: searchSize,
      lang: "ko",
      country: "kr",
      fullDetail: false,
    });

    const topApps = (searchResults || []).slice(0, detailSize);
    const appDetails = [];

    for (const appInfo of topApps) {
      try {
        const detail = await gplay.app({
          appId: appInfo.appId,
          lang: "ko",
          country: "kr",
        });

        const histogram = detail.histogram || {};
        const ratings = toNumber(detail.ratings);
        appDetails.push({
          appId: detail.appId,
          title: detail.title,
          developer: detail.developer,
          score: detail.score,
          ratings: detail.ratings,
          histogram: detail.histogram,
          installs: detail.installs,
          minInstalls: detail.minInstalls,
          maxInstalls: detail.maxInstalls,
          offers_iap: detail.offersIAP,
          ad_supported: detail.adSupported,
          neg_rate: formatPercent(toNumber(histogram[1]) + toNumber(histogram[2]), ratings),
        });
      } catch (_innerErr) {
        // 일부 앱 실패는 무시
      }
    }

    const searchData = {
      apps: (searchResults || []).map((item) => ({
        appId: item.appId,
        score: item.score,
      })),
    };

    return res.json({ metrics: buildMarketMetrics(keyword, searchData, appDetails) });
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
  .slice(0, 10)
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

const PORT = 3000;
app.listen(PORT, () => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ◈ AppSourcer 실행 중!");
  console.log(`  ▶ 크롬에서 열기: http://localhost:${PORT}`);
  console.log("  ■ 종료하려면: Ctrl + C");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});

function parseInstallsBounds(detail) {
  const directMin = toNumber(detail?.minInstalls);
  const directMax = toNumber(detail?.maxInstalls);
  if (directMin > 0 && directMax >= directMin) {
    return { min: directMin, max: directMax };
  }

  const raw = String(detail?.installs || "");
  const num = toNumber(raw.replace(/[^0-9]/g, ""));
  if (num > 0) {
    return { min: num, max: Math.max(num, Math.floor(num * 3)) };
  }

  return { min: 0, max: 0 };
}

function formatKRW(value) {
  return `KRW ${Math.round(value).toLocaleString("en-US")}`;
}

function estimateMonthlyRevenue(detailLike) {
  const installs = parseInstallsBounds(detailLike);
  const minActive = installs.min * 0.02;
  const maxActive = installs.max * 0.08;

  let low = 0;
  let high = 0;

  if (detailLike?.offers_iap) {
    const lowPaidUsers = minActive * 0.008;
    const highPaidUsers = maxActive * 0.025;
    low += lowPaidUsers * 9000;
    high += highPaidUsers * 23000;
  }

  if (detailLike?.ad_supported) {
    const lowImpressions = minActive * 20;
    const highImpressions = maxActive * 60;
    low += (lowImpressions / 1000) * 2000;
    high += (highImpressions / 1000) * 6000;
  }

  return {
    low,
    high,
    lowLabel: formatKRW(low),
    highLabel: formatKRW(high),
    rangeLabel: `${formatKRW(low)} ~ ${formatKRW(high)}`,
    assumptions: {
      activeUserRate: "2% ~ 8% of installs",
      iapConversionRate: "0.8% ~ 2.5%",
      iapARPPU: "KRW 9,000 ~ 23,000/month",
      adImpressionsPerUser: "20 ~ 60 per month",
      adECPM: "KRW 2,000 ~ 6,000",
    },
  };
}
