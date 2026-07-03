/* =========================================================
   Mary&May TikTok 어필리에잇 대시보드
   원본: 어필리에잇 로우데이터 (Google Sheets)
   ========================================================= */

const SHEET_ID = '1I94_eBKmYHs3HtAEbI1h3cZx5ZhH7G8vLEuf4Koqc1k';
const GIDS = {
  picky: '0',            // 피키 로우데이터 (자동)
  nuri: '530164290',     // 누리 로우데이터 (자동)
  gcd: '670984473',      // GCD 로우데이터 (수기)
  gec: '704602447',      // GEC 로우데이터 (수기)
  spark: '1393881713',   // 스파크애즈 (수기)
  gmvmax: '327690174'    // GMVMAX (수기)
};

const TIER_STORAGE_KEY = 'mm_affiliate_tiers_v1';

let state = {
  creators: [],     // grouped creator objects
  unmatchedSparkTotal: 0,
  lastSync: null
};

/* ---------------- Google Sheets (gviz) fetch ---------------- */

async function fetchSheetTable(gid) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`시트 로드 실패 (gid=${gid}, status=${res.status})`);
  const text = await res.text();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('시트 응답 파싱 실패');
  const json = JSON.parse(text.substring(start, end + 1));
  return json.table;
}

function cellVal(cell) {
  if (!cell) return null;
  // 포맷된 문자열(f)을 우선 사용: 틱톡 영상 ID처럼 19자리 큰 숫자가 시트에 "숫자"로
  // 저장돼 있으면 v(부동소수점)로 읽을 때 자바스크립트 정밀도 한계(15~16자리)로
  // 뒷자리가 깨져서 Post ID 매칭이 통째로 실패하는 문제가 있었음. f는 시트에 표시되는
  // 그대로의 정확한 문자열이라 이 문제가 없음.
  if (cell.f !== undefined && cell.f !== null && cell.f !== '') return cell.f;
  return cell.v !== undefined ? cell.v : null;
}
function cellNum(cell) {
  const v = cellVal(cell);
  if (v === null || v === '' || v === '-' || v === '--') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}
function cellStr(cell) {
  const v = cellVal(cell);
  return v === null ? '' : String(v).trim();
}
function cellDate(cell) {
  if (!cell) return null;
  const v = cell.v;
  if (typeof v === 'string' && v.startsWith('Date(')) {
    const m = v.match(/Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)/);
    if (m) return new Date(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  if (cell.f) {
    const d = new Date(cell.f);
    if (!isNaN(d)) return d;
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!isNaN(d)) return d;
  }
  return null;
}

function extractVideoId(link) {
  if (!link) return null;
  const m = String(link).match(/video\/(\d+)/);
  return m ? m[1] : null;
}
function extractHandle(text) {
  if (!text) return null;
  const m = String(text).match(/@([a-zA-Z0-9._]+)/);
  return m ? m[1].toLowerCase() : null;
}

/* ---------------- Parsers per sheet ---------------- */

function parsePicky(table) {
  const rows = table.rows || [];
  const videos = [];
  for (const row of rows) {
    const c = row.c || [];
    const username = cellStr(c[3]);
    if (!username) continue;
    const link = cellStr(c[10]);
    videos.push({
      source: 'picky',
      postDate: cellDate(c[0]), // Submitted At — 원본에 별도 게시일 컬럼이 없어 대체 사용
      username,
      socialHandle: cellStr(c[5]).toLowerCase(),
      followerCount: cellNum(c[6]),
      videoLink: link,
      videoId: extractVideoId(link),
      views: cellNum(c[12]),
      impressions: null,
      likes: cellNum(c[13]),
      comments: cellNum(c[14]),
      orders: cellNum(c[15]),
      gmv: cellNum(c[16]),
      campaign: null,
      tierHint: null
    });
  }
  return videos;
}

// 누리(자동) / GEC(수기): 컬럼 배치가 거의 동일, offset만 다름
// requireFlagO=true면 A열이 정확히 'O'인 행만 채택 (누리: 'X'는 누리 진행 아님)
function parseVideoListSheet(table, sourceName, colOffset, requireFlagO) {
  const rows = table.rows || [];
  const videos = [];
  const off = colOffset; // 누리=1 (앞에 여부 컬럼 있음), GEC=0
  for (const row of rows) {
    const c = row.c || [];
    if (requireFlagO && cellStr(c[0]).toUpperCase() !== 'O') continue;
    const link = cellStr(c[1 + off]);
    const username = cellStr(c[3 + off]);
    if (!username || !link) continue;
    videos.push({
      source: sourceName,
      postDate: cellDate(c[2 + off]),
      username,
      socialHandle: null,
      followerCount: 0,
      videoLink: link,
      videoId: extractVideoId(link),
      views: null,
      impressions: cellNum(c[11 + off]),
      likes: cellNum(c[17 + off]),
      comments: cellNum(c[16 + off]),
      orders: cellNum(c[10 + off]),
      gmv: cellNum(c[4 + off]),
      campaign: null,
      tierHint: null
    });
  }
  return videos;
}

// GCD(수기): 여러 캠페인 블록이 세로로 쌓인 비정형 시트.
// 한 행 = 크리에이터 1명, 그 안에 링크가 여러 개 가로로 나열되어 있고 날짜/영상별 지표는 없음.
function parseGCD(table) {
  const rows = table.rows || [];
  const HEADER_WORDS = ['이름', 'tiktok id', 'sample', '링크 1', 'link 1', 'ad code 1', 'extras'];
  const linkRe = /((?:https?:\/\/)?(?:www\.|vm\.)?tiktok\.com\/[^\s]*?video\/(\d+)[^\s]*)/gi;

  let currentCampaign = '기타 (GCD)';
  const videos = [];

  for (const row of rows) {
    const c = row.c || [];
    const values = [];
    for (let i = 0; i < c.length; i++) values[i] = cellStr(c[i]);
    const nonEmpty = values.map((v, i) => v ? i : -1).filter(i => i >= 0);
    if (nonEmpty.length === 0) continue;

    const lowerVals = values.map(v => v.toLowerCase());
    const isHeaderRow = HEADER_WORDS.some(w => lowerVals.includes(w));
    if (isHeaderRow) continue;

    // 캠페인 구획 제목: 앞쪽(B~C열)에 텍스트 하나만 있고 링크가 전혀 없는 행
    const hasAnyLink = values.some(v => linkRe.test(v));
    linkRe.lastIndex = 0;
    if (nonEmpty.length === 1 && nonEmpty[0] <= 3 && !hasAnyLink) {
      currentCampaign = values[nonEmpty[0]];
      continue;
    }

    // 크리에이터 이름 컬럼 찾기: "Sample" 같은 설명 태그(쉼표/공백 포함)와 구분하기 위해
    // 유저네임처럼 생긴 값(영문/숫자/./_ + 선택적 (Lx))을 우선으로 찾는다
    const looksLikeUsername = s => /^[a-zA-Z0-9_.]+(\s*\(L\d+\))?$/.test(s.trim());
    let nameIdx = -1;
    for (const i of [1, 2, 3]) {
      if (values[i] && looksLikeUsername(values[i])) { nameIdx = i; break; }
    }
    if (nameIdx === -1) {
      for (const i of [1, 2, 3]) {
        if (values[i] && !linkRe.test(values[i])) { nameIdx = i; break; }
        linkRe.lastIndex = 0;
      }
    }
    linkRe.lastIndex = 0;
    if (nameIdx === -1) continue;

    const rawName = values[nameIdx];
    const tierMatch = rawName.match(/\(L\d+\)/i);
    const tierHint = tierMatch ? tierMatch[0].replace(/[()]/g, '').toUpperCase() : null;
    const username = rawName.replace(/\(L\d+\)/i, '').trim();
    if (!username) continue;

    // 이후 컬럼들에서 링크 전부 추출 (여러 줄 텍스트 셀도 포함)
    const foundIds = new Set();
    let gmv = 0;
    for (let i = nameIdx + 1; i < values.length; i++) {
      const raw = values[i];
      if (!raw) continue;
      const numMatch = raw.match(/^\$?[\d,]+(\.\d+)?$/);
      if (numMatch) { gmv = parseFloat(raw.replace(/[$,]/g, '')); continue; }
      let m;
      linkRe.lastIndex = 0;
      while ((m = linkRe.exec(raw)) !== null) {
        const videoId = m[2];
        if (foundIds.has(videoId)) continue;
        foundIds.add(videoId);
        let url = m[1];
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        videos.push({
          source: 'gcd',
          postDate: null,
          username,
          socialHandle: null,
          followerCount: 0,
          videoLink: url,
          videoId,
          views: null,
          impressions: null,
          likes: 0,
          comments: 0,
          orders: 0,
          gmv: 0, // GCD는 크리에이터 합산 GMV만 있고 영상별 GMV는 없음
          campaign: currentCampaign,
          tierHint
        });
      }
    }
  }
  return videos;
}

function parseGmvMax(table) {
  const rows = table.rows || [];

  // 1단계: postId + 날짜 조합으로 중복 제거 (같은 날짜를 실수로 두 번 붙여넣은 경우 대비, 마지막 값 사용)
  const dailyMap = new Map();
  for (const row of rows) {
    const c = row.c || [];
    // 쉼표/공백 등 숫자가 아닌 문자를 제거 — 시트에서 Post ID가 "숫자" 서식으로
    // 저장돼 있으면 표시 문자열에 천단위 쉼표(예: 7,642,431,...)가 끼어서
    // 영상 링크에서 뽑은 순수 숫자 ID와 매칭이 실패하는 문제가 있었음.
    const postId = cellStr(c[1]).replace(/[^\d]/g, '');
    if (!postId || postId === 'N/A') continue;
    const date = cellDate(c[0]);
    const dateKey = date ? date.toISOString().slice(0, 10) : cellStr(c[0]);
    const key = postId + '||' + dateKey;
    dailyMap.set(key, {
      postId,
      date,
      cost: cellNum(c[8]),          // 그날 하루치 실제 소진액
      skuOrders: cellNum(c[9]),     // 그날 하루치 주문수
      grossRevenue: cellNum(c[11]), // 그날 하루치 매출
      impressions: cellNum(c[13]),  // 그날 하루치 노출
      clicks: cellNum(c[14])        // 그날 하루치 클릭
    });
  }

  // 2단계: postId 기준으로 일자별 값을 전부 합산 (누적 광고비 = 일별 소진액의 합)
  const map = new Map();
  for (const entry of dailyMap.values()) {
    if (!map.has(entry.postId)) {
      map.set(entry.postId, {
        postId: entry.postId,
        cost: 0, skuOrders: 0, grossRevenue: 0, impressions: 0, clicks: 0,
        days: 0, firstDate: null, lastDate: null
      });
    }
    const agg = map.get(entry.postId);
    agg.cost += entry.cost;
    agg.skuOrders += entry.skuOrders;
    agg.grossRevenue += entry.grossRevenue;
    agg.impressions += entry.impressions;
    agg.clicks += entry.clicks;
    agg.days += 1;
    if (entry.date) {
      if (!agg.firstDate || entry.date < agg.firstDate) agg.firstDate = entry.date;
      if (!agg.lastDate || entry.date > agg.lastDate) agg.lastDate = entry.date;
    }
  }

  // 3단계: 비율 지표는 합산된 총합으로 재계산 (비율끼리 더하면 안 됨)
  for (const agg of map.values()) {
    agg.clickRate = agg.impressions ? agg.clicks / agg.impressions : 0;
    agg.convRate = agg.clicks ? agg.skuOrders / agg.clicks : 0;
    agg.roi = agg.cost ? agg.grossRevenue / agg.cost : 0;
  }

  return map;
}

function parseSparkAds(table) {const rows = table.rows || [];
  // dedupe by adName + day (keep last occurrence = most recently appended)
  const dedup = new Map();
  for (const row of rows) {
    const c = row.c || [];
    const adName = cellStr(c[3]);
    const day = cellStr(c[4]);
    if (!adName) continue;
    const key = adName + '||' + day;
    dedup.set(key, {
      adName,
      adGroup: cellStr(c[2]),
      campaign: cellStr(c[1]),
      day,
      impressions: cellNum(c[9]),
      cost: cellNum(c[10]),
      clicks: cellNum(c[11])
    });
  }
  // aggregate by extracted handle
  const byHandle = new Map();
  const unmatchedRows = [];
  for (const entry of dedup.values()) {
    const handle = extractHandle(entry.adName) || extractHandle(entry.adGroup) || extractHandle(entry.campaign);
    if (!handle) { unmatchedRows.push(entry); continue; }
    if (!byHandle.has(handle)) {
      byHandle.set(handle, { handle, impressions: 0, clicks: 0, cost: 0, rows: 0 });
    }
    const agg = byHandle.get(handle);
    agg.impressions += entry.impressions;
    agg.clicks += entry.clicks;
    agg.cost += entry.cost;
    agg.rows += 1;
  }
  return { byHandle, unmatchedRows };
}

/* ---------------- Join + group ---------------- */

// GEC 로우데이터를 "전체 기준 리스트"로 삼고, 피키/누리/GCD는 각 영상의 모집 출처를
// 알려주는 태그로만 사용한다. (사용자 확정 기준)
function buildMasterVideoList(picky, nuri, gec, gcd) {
  const idsOf = list => new Set(list.filter(v => v.videoId).map(v => v.videoId));
  const pickyIds = idsOf(picky);
  const nuriIds = idsOf(nuri);
  const gcdIds = idsOf(gcd);

  function originOf(videoId) {
    if (pickyIds.has(videoId)) return '피키';
    if (nuriIds.has(videoId)) return '누리';
    if (gcdIds.has(videoId)) return 'GCD';
    return 'GEC';
  }

  const master = [];
  const seenIds = new Set();

  // 1) GEC = 기준 리스트. 전부 포함하고, 출처(어디서 모집됐는지)만 태깅.
  for (const v of gec) {
    const origin = v.videoId ? originOf(v.videoId) : 'GEC';
    master.push({ ...v, origin, registeredInGec: true });
    if (v.videoId) seenIds.add(v.videoId);
  }

  // 2) GEC에는 없지만 다른 소스엔 있는 영상 — 데이터 누락 방지를 위해 추가하되
  //    "GEC 미등록"으로 표시해서 구분한다 (우선순위: 피키 > 누리 > GCD)
  for (const { list, tag } of [{ list: picky, tag: '피키' }, { list: nuri, tag: '누리' }, { list: gcd, tag: 'GCD' }]) {
    for (const v of list) {
      if (!v.videoId || seenIds.has(v.videoId)) continue;
      seenIds.add(v.videoId);
      master.push({ ...v, origin: tag, registeredInGec: false });
    }
  }

  return master;
}

// GCD 이름에 (L0)/(L2) 처럼 붙어있는 티어 힌트는, 그 영상이 위에서 중복 제거되어
// 빠지더라도 크리에이터에게는 계속 반영되도록 별도로 모아둔다.
function buildTierHintMap(gcdRows) {
  const map = new Map();
  for (const v of gcdRows) {
    if (v.tierHint && v.username && !map.has(v.username.toLowerCase())) {
      map.set(v.username.toLowerCase(), v.tierHint);
    }
  }
  return map;
}

function buildDashboardData(allVideos, gmvMaxMap, sparkResult, tierHintMap) {
  const creatorMap = new Map();

  for (const v of allVideos) {
    const key = v.username.toLowerCase();
    if (!creatorMap.has(key)) {
      creatorMap.set(key, {
        username: v.username,
        socialHandle: null,
        followerCount: 0,
        tierHint: null,
        videos: []
      });
    }
    const creator = creatorMap.get(key);
    if (v.socialHandle) creator.socialHandle = v.socialHandle;
    if (v.followerCount) creator.followerCount = Math.max(creator.followerCount, v.followerCount);
    if (v.tierHint && !creator.tierHint) creator.tierHint = v.tierHint;

    let gmvMax = null;
    if (v.videoId && gmvMaxMap.has(v.videoId)) {
      gmvMax = gmvMaxMap.get(v.videoId);
    }
    creator.videos.push({ ...v, gmvMax });
  }

  // 소셜핸들이 없는 크리에이터는 유저네임을 핸들 대체값으로 사용 (스파크애즈 매칭용, best-effort)
  // GCD 이름에서 뽑은 티어 힌트도 여기서 백필 (해당 영상이 GEC 중복으로 걸러졌어도 반영되도록)
  for (const creator of creatorMap.values()) {
    if (!creator.socialHandle) creator.socialHandle = creator.username.toLowerCase();
    if (!creator.tierHint && tierHintMap) {
      const hint = tierHintMap.get(creator.username.toLowerCase());
      if (hint) creator.tierHint = hint;
    }
  }

  // 스파크애즈를 소셜핸들 기준으로 매칭
  const matchedHandles = new Set();
  for (const creator of creatorMap.values()) {
    const spark = sparkResult.byHandle.get(creator.socialHandle) || null;
    creator.spark = spark;
    if (spark) matchedHandles.add(creator.socialHandle);
  }
  let unmatchedSparkTotal = 0;
  const sparkUnmatchedDetails = [];
  for (const [handle, agg] of sparkResult.byHandle.entries()) {
    if (!matchedHandles.has(handle)) {
      unmatchedSparkTotal += agg.cost;
      sparkUnmatchedDetails.push({
        name: handle,
        cost: agg.cost,
        impressions: agg.impressions,
        clicks: agg.clicks,
        type: 'handle-unmatched',
        raw: `@${handle} (Ad name ${agg.rows}건 합산)`
      });
    }
  }
  for (const row of sparkResult.unmatchedRows) {
    unmatchedSparkTotal += row.cost;
    sparkUnmatchedDetails.push({
      name: null,
      cost: row.cost,
      impressions: row.impressions,
      clicks: row.clicks,
      type: 'no-handle',
      raw: row.adName
    });
  }

  const creators = Array.from(creatorMap.values()).map(c => {
    // 날짜 있는 영상은 최신순, 날짜 없는 영상(GCD)은 맨 아래로
    c.videos.sort((a, b) => {
      if (a.postDate && b.postDate) return b.postDate - a.postDate;
      if (a.postDate && !b.postDate) return -1;
      if (!a.postDate && b.postDate) return 1;
      return 0;
    });
    c.totalGmv = c.videos.reduce((s, v) => s + v.gmv, 0);
    c.datedVideoCount = c.videos.filter(v => v.postDate).length;
    c.undatedVideoCount = c.videos.filter(v => !v.postDate).length;
    c.latestDate = c.videos.find(v => v.postDate) ? c.videos.find(v => v.postDate).postDate : null;
    return c;
  });

  return { creators, unmatchedSparkTotal, sparkUnmatchedDetails, undatedTotal: creators.reduce((s, c) => s + c.undatedVideoCount, 0) };
}

/* ---------------- Tier storage ---------------- */

function loadTiers() {
  try {
    return JSON.parse(localStorage.getItem(TIER_STORAGE_KEY) || '{}');
  } catch (e) { return {}; }
}
function saveTier(username, tier) {
  const tiers = loadTiers();
  if (tier) tiers[username] = tier;
  else delete tiers[username];
  localStorage.setItem(TIER_STORAGE_KEY, JSON.stringify(tiers));
}
function exportTiersCsv() {
  const tiers = loadTiers();
  const rows = [['username', 'tier']];
  Object.entries(tiers).forEach(([u, t]) => rows.push([u, t]));
  const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tiers_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}
function importTiersCsv(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const lines = String(reader.result).split(/\r?\n/).filter(Boolean);
    const tiers = loadTiers();
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].match(/^"?([^",]*)"?,"?([^",]*)"?$/);
      if (m) tiers[m[1]] = m[2];
    }
    localStorage.setItem(TIER_STORAGE_KEY, JSON.stringify(tiers));
    render();
  };
  reader.readAsText(file);
}

/* ---------------- Formatting ---------------- */

const fmtInt = n => Math.round(n).toLocaleString('ko-KR');
const fmtUsd = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtKrw = n => '₩' + Math.round(n).toLocaleString('ko-KR');
const fmtPct = n => (n * 100).toFixed(2) + '%';
const fmtDate = d => d ? d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';

/* ---------------- Render ---------------- */

function renderKpis(data) {
  const totalVideos = data.creators.reduce((s, c) => s + c.videos.length, 0);
  const totalGmv = data.creators.reduce((s, c) => s + c.totalGmv, 0);
  const gmvMaxCost = data.creators.reduce((s, c) => s + c.videos.reduce((s2, v) => s2 + (v.gmvMax ? v.gmvMax.cost : 0), 0), 0);
  const sparkCost = data.creators.reduce((s, c) => s + (c.spark ? c.spark.cost : 0), 0);

  document.getElementById('kpiCreators').textContent = fmtInt(data.creators.length);
  document.getElementById('kpiVideos').textContent = fmtInt(totalVideos);
  document.getElementById('kpiGmv').textContent = fmtUsd(totalGmv);
  document.getElementById('kpiGmvMaxCost').textContent = fmtKrw(gmvMaxCost);
  document.getElementById('kpiSparkCost').textContent = fmtKrw(sparkCost);
  document.getElementById('kpiUnmatchedSpark').textContent = fmtKrw(data.unmatchedSparkTotal);
}

function renderSparkUnmatched(details) {
  const tbody = document.getElementById('sparkUnmatchedBody');
  if (!tbody) return;
  if (!details || details.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">미매칭 스파크애즈 지출이 없습니다.</td></tr>`;
    return;
  }
  const sorted = [...details].sort((a, b) => b.cost - a.cost);
  tbody.innerHTML = sorted.map(d => `
    <tr>
      <td class="creator-cell">${d.name || '(핸들 추출 실패)'}</td>
      <td><span class="badge ${d.type === 'no-handle' ? 'badge-warn' : 'badge-none'}">${d.type === 'no-handle' ? '핸들 추출 실패' : '핸들은 뽑혔지만 매칭 안 됨'}</span></td>
      <td class="num">${fmtKrw(d.cost)}</td>
      <td class="num">${fmtInt(d.impressions || 0)}</td>
      <td class="num">${fmtInt(d.clicks || 0)}</td>
      <td class="stat-label">${d.raw || '-'}</td>
    </tr>`).join('');
}

function renderTierFilterOptions() {
  const tiers = loadTiers();
  const uniqueTiers = Array.from(new Set(Object.values(tiers).filter(Boolean))).sort();
  const sel = document.getElementById('tierFilter');
  const current = sel.value;
  sel.innerHTML = '<option value="">전체 티어</option>' +
    uniqueTiers.map(t => `<option value="${t}">${t}</option>`).join('');
  sel.value = current;
}function videoRow(v) {
  const gm = v.gmvMax;
  const adBadge = gm
    ? `<span class="badge badge-gmvmax">GMV MAX</span>`
    : `<span class="badge badge-none">미집행</span>`;
  const originBadge = `<span class="badge badge-none" title="모집 출처">${v.origin}</span>`;
  const unregBadge = v.registeredInGec === false ? `<span class="badge badge-warn" title="GEC 로우데이터에는 없는 영상">GEC 미등록</span>` : '';
  const viewsOrImpr = v.views !== null ? v.views : (v.impressions !== null ? v.impressions : 0);
  const gmvCell = v.origin === 'GCD' && v.gmv === 0 ? '-' : fmtUsd(v.gmv);
  const orders = gm ? gm.skuOrders : v.orders;
  return `
    <tr class="${!v.postDate ? 'row-undated' : ''}">
      <td>${v.postDate ? fmtDate(v.postDate) : '날짜 미상'}</td>
      <td><a class="vlink" href="${v.videoLink}" target="_blank" rel="noopener">영상 링크 ↗</a> ${originBadge} ${adBadge} ${unregBadge}</td>
      <td class="num">${fmtInt(viewsOrImpr)}</td>
      <td class="num">${fmtInt(orders)}</td>
      <td class="num">${gmvCell}</td>
      <td class="num">${gm ? fmtInt(gm.impressions) : '-'}</td>
      <td class="num">${gm ? fmtInt(gm.clicks) : '-'}</td>
      <td class="num">${gm ? fmtPct(gm.clickRate) : '-'}</td>
      <td class="num">${gm ? fmtKrw(gm.cost) : '-'}</td>
    </tr>`;
}

function creatorCard(creator, idx) {
  const tiers = loadTiers();
  const tier = tiers[creator.username] !== undefined ? tiers[creator.username] : (creator.tierHint || '');
  const sparkHtml = creator.spark
    ? `<div class="spark-summary">
         <span><span class="dot dot-spark" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;"></span></span>
         <span><span class="label">스파크애즈 노출</span><span class="value">${fmtInt(creator.spark.impressions)}</span></span>
         <span><span class="label">클릭</span><span class="value">${fmtInt(creator.spark.clicks)}</span></span>
         <span><span class="label">CTR</span><span class="value">${fmtPct(creator.spark.impressions ? creator.spark.clicks / creator.spark.impressions : 0)}</span></span>
         <span><span class="label">광고비 소진</span><span class="value">${fmtKrw(creator.spark.cost)}</span></span>
       </div>`
    : `<div class="spark-summary unmatched">스파크애즈 집행 내역 없음 / 미매칭 (소셜핸들 추정값: ${creator.socialHandle || '없음'})</div>`;

  const rows = creator.videos.map(videoRow).join('');
  const undatedNote = creator.undatedVideoCount > 0
    ? `<p class="stat-label" style="margin:8px 0 0;">※ GCD 소스 영상 ${creator.undatedVideoCount}개는 업로드 날짜 정보가 없어 목록 맨 아래에 표시됩니다.</p>`
    : '';

  return `
    <div class="creator-card" data-idx="${idx}">
      <div class="creator-head" data-toggle="${idx}">
        <span class="chev">▶</span>
        <div class="creator-id">
          <span class="creator-name">${creator.username}</span>
          <span class="creator-handle">@${creator.socialHandle || '-'} · 팔로워 ${fmtInt(creator.followerCount)}</span>
        </div>
        <input class="tier-input" placeholder="티어 입력" value="${tier}" data-tier-username="${creator.username}" onclick="event.stopPropagation()">
        <div class="stat"><span class="stat-label">영상 수</span><span class="stat-value">${creator.videos.length}</span></div>
        <div class="stat"><span class="stat-label">최근 업로드</span><span class="stat-value">${creator.latestDate ? creator.latestDate.toLocaleDateString('ko-KR') : '-'}</span></div>
        <div class="stat"><span class="stat-label">GMV</span><span class="stat-value accent">${fmtUsd(creator.totalGmv)}</span></div>
        <div class="stat"><span class="stat-label">스파크 광고비</span><span class="stat-value coral">${creator.spark ? fmtKrw(creator.spark.cost) : '-'}</span></div>
        <span></span>
      </div>
      <div class="creator-body">
        ${sparkHtml}
        <table class="video-table">
          <thead>
            <tr>
              <th>업로드 일시</th>
              <th>영상 (출처)</th>
              <th class="num">조회/노출</th>
              <th class="num">전환수</th>
              <th class="num">GMV</th>
              <th class="num">노출 (GMV MAX)</th>
              <th class="num">클릭 (GMV MAX)</th>
              <th class="num">CTR (GMV MAX)</th>
              <th class="num">광고비 (GMV MAX)</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${undatedNote}
      </div>
    </div>`;
}

let openIndexes = new Set();

function render() {
  renderTierFilterOptions();

  const search = document.getElementById('searchInput').value.trim().toLowerCase();
  const sortBy = document.getElementById('sortSelect').value;
  const tierFilterVal = document.getElementById('tierFilter').value;
  const tiers = loadTiers();

  let list = state.creators.filter(c => {
    if (search && !(c.username.toLowerCase().includes(search) || (c.socialHandle || '').includes(search))) return false;
    if (tierFilterVal && (tiers[c.username] || '') !== tierFilterVal) return false;
    return true;
  });

  if (sortBy === 'recent') list.sort((a, b) => (b.latestDate || 0) - (a.latestDate || 0));
  else if (sortBy === 'gmv') list.sort((a, b) => b.totalGmv - a.totalGmv);
  else if (sortBy === 'videos') list.sort((a, b) => b.videos.length - a.videos.length);
  else if (sortBy === 'alpha') list.sort((a, b) => a.username.localeCompare(b.username));

  const container = document.getElementById('creatorList');
  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state">조건에 맞는 크리에이터가 없습니다.</div>`;
    return;
  }

  container.innerHTML = list.map((c, i) => creatorCard(c, i)).join('');

  container.querySelectorAll('[data-toggle]').forEach(head => {
    head.addEventListener('click', () => {
      const card = head.closest('.creator-card');
      card.classList.toggle('open');
    });
  });
  container.querySelectorAll('[data-tier-username]').forEach(input => {
    input.addEventListener('change', (e) => {
      saveTier(e.target.dataset.tierUsername, e.target.value.trim());
      renderTierFilterOptions();
    });
  });

  renderKpis(state);
}

let currentView = 'videos';
let videoSort = 'impressions';

function flattenAllVideos() {
  const tiers = loadTiers();
  const out = [];
  for (const c of state.creators) {
    const tier = tiers[c.username] !== undefined ? tiers[c.username] : (c.tierHint || '');
    for (const v of c.videos) {
      out.push({ ...v, creatorUsername: c.username, creatorSocialHandle: c.socialHandle, tier });
    }
  }
  return out;
}

function fullListRow(v) {
  const gm = v.gmvMax;
  const adBadge = gm ? `<span class="badge badge-gmvmax">GMV MAX</span>` : `<span class="badge badge-none">미집행</span>`;
  const originBadge = `<span class="badge badge-none" title="모집 출처">${v.origin}</span>`;
  const unregBadge = v.registeredInGec === false ? `<span class="badge badge-warn" title="GEC 로우데이터에는 없는 영상">GEC 미등록</span>` : '';
  const viewsOrImpr = v.views !== null ? v.views : (v.impressions !== null ? v.impressions : 0);
  const gmvCell = v.origin === 'GCD' && v.gmv === 0 ? '-' : fmtUsd(v.gmv);
  const orders = gm ? gm.skuOrders : v.orders;
  return `
    <tr class="${!v.postDate ? 'row-undated' : ''}">
      <td class="creator-cell">${v.creatorUsername}${v.tier ? `<span class="tier-tag">${v.tier}</span>` : ''}</td>
      <td>${v.postDate ? v.postDate.toLocaleDateString('ko-KR') : '날짜 미상'}</td>
      <td><a class="vlink" href="${v.videoLink}" target="_blank" rel="noopener">영상 링크 ↗</a> ${originBadge} ${adBadge} ${unregBadge}</td>
      <td class="num">${fmtInt(viewsOrImpr)}</td>
      <td class="num">${fmtInt(orders)}</td>
      <td class="num">${gmvCell}</td>
      <td class="num">${gm ? fmtInt(gm.impressions) : '-'}</td>
      <td class="num">${gm ? fmtInt(gm.clicks) : '-'}</td>
      <td class="num">${gm ? fmtPct(gm.clickRate) : '-'}</td>
      <td class="num">${gm ? fmtKrw(gm.cost) : '-'}</td>
    </tr>`;
}

function renderVideoListView() {
  const search = document.getElementById('searchInput').value.trim().toLowerCase();
  const tierFilterVal = document.getElementById('tierFilter').value;
  const adOnly = document.getElementById('adOnlyFilter').checked;

  let list = flattenAllVideos().filter(v => {
    if (search && !(v.creatorUsername.toLowerCase().includes(search) || (v.creatorSocialHandle || '').includes(search))) return false;
    if (tierFilterVal && v.tier !== tierFilterVal) return false;
    if (adOnly && !v.gmvMax) return false;
    return true;
  });

  const val = v => {
    switch (videoSort) {
      case 'impressions': return v.gmvMax ? v.gmvMax.impressions : -1;
      case 'orders': return v.gmvMax ? v.gmvMax.skuOrders : v.orders;
      case 'cost': return v.gmvMax ? v.gmvMax.cost : -1;
      case 'gmv': return v.gmv;
      case 'recent': return v.postDate ? v.postDate.getTime() : -1;
      default: return 0;
    }
  };
  list.sort((a, b) => val(b) - val(a));

  const tbody = document.getElementById('videoListBody');
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">조건에 맞는 영상이 없습니다.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(fullListRow).join('');
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('videoListView').hidden = view !== 'videos';
  document.getElementById('creatorList').hidden = view !== 'creators';
  if (view === 'videos') renderVideoListView();
  else render();
}

document.querySelectorAll('.view-tab').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
document.querySelectorAll('.sort-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    videoSort = btn.dataset.sort;
    document.querySelectorAll('.sort-chip').forEach(b => b.classList.toggle('active', b === btn));
    renderVideoListView();
  });
});
document.getElementById('adOnlyFilter').addEventListener('change', renderVideoListView);

/* ---------------- Load pipeline ---------------- */

function setSync(status, text) {
  const dot = document.getElementById('syncDot');
  dot.className = 'dot ' + status;
  document.getElementById('syncText').textContent = text;
}

async function loadAll() {
  setSync('loading', '구글시트 6개 탭 불러오는 중…');
  document.getElementById('unmatchedNotice').hidden = true;
  try {
    const [pickyT, nuriT, gcdT, gecT, gmvmaxT, sparkT] = await Promise.all([
      fetchSheetTable(GIDS.picky),
      fetchSheetTable(GIDS.nuri),
      fetchSheetTable(GIDS.gcd),
      fetchSheetTable(GIDS.gec),
      fetchSheetTable(GIDS.gmvmax),
      fetchSheetTable(GIDS.spark)
    ]);

    const pickyRows = parsePicky(pickyT);
    const nuriRows = parseVideoListSheet(nuriT, 'nuri', 1, true);
    const gecRows = parseVideoListSheet(gecT, 'gec', 0, false);
    const gcdRows = parseGCD(gcdT);
    const gmvMaxMap = parseGmvMax(gmvmaxT);
    const sparkResult = parseSparkAds(sparkT);

    const master = buildMasterVideoList(pickyRows, nuriRows, gecRows, gcdRows);
    const tierHintMap = buildTierHintMap(gcdRows);
    const data = buildDashboardData(master, gmvMaxMap, sparkResult, tierHintMap);
    state.creators = data.creators;
    state.unmatchedSparkTotal = data.unmatchedSparkTotal;
    state.lastSync = new Date();

    const unregCount = master.filter(v => v.registeredInGec === false).length;
    if (data.unmatchedSparkTotal > 0 || data.undatedTotal > 0 || unregCount > 0) {
      const el = document.getElementById('unmatchedNotice');
      el.hidden = false;
      const msgs = [];
      if (data.unmatchedSparkTotal > 0) {
        msgs.push(`⚠ 스파크애즈 지출 ${fmtKrw(data.unmatchedSparkTotal)}이(가) 크리에이터와 매칭되지 않았습니다 (Ad name에서 계정 핸들을 찾지 못했거나, 로우데이터의 계정과 다릅니다). 스파크애즈는 원본에 영상 링크가 없어 크리에이터 단위로만 합산됩니다.`);
      }
      if (unregCount > 0) {
        msgs.push(`ℹ GEC 로우데이터에는 없지만 피키/누리/GCD에만 있는 영상 ${unregCount}개를 놓치지 않도록 함께 표시했습니다 ("GEC 미등록" 배지).`);
      }
      if (data.undatedTotal > 0) {
        msgs.push(`ℹ GCD 출처 영상 ${data.undatedTotal}개는 업로드 날짜 정보가 없어 목록 맨 아래에 정렬 없이 표시됩니다.`);
      }
      el.innerHTML = msgs.join('<br>');
    }

    setSync('ok', `마지막 동기화 ${state.lastSync.toLocaleTimeString('ko-KR')} · GEC 기준 통합`);
    renderKpis(state);
    renderSparkUnmatched(data.sparkUnmatchedDetails);
    renderTierFilterOptions();
    if (currentView === 'videos') renderVideoListView();
    else render();
  } catch (err) {
    console.error(err);
    setSync('err', '데이터 로드 실패 — 새로고침을 눌러 다시 시도해주세요');
    document.getElementById('creatorList').innerHTML =
      `<div class="empty-state">데이터를 불러오지 못했습니다.<br>${err.message}<br><br>구글시트가 "링크가 있는 모든 사용자" 권한으로 공유되어 있는지 확인해주세요.</div>`;
  }
}

/* ---------------- Init ---------------- */

document.getElementById('refreshBtn').addEventListener('click', loadAll);
document.getElementById('searchInput').addEventListener('input', () => currentView === 'videos' ? renderVideoListView() : render());
document.getElementById('sortSelect').addEventListener('change', render);
document.getElementById('tierFilter').addEventListener('change', () => currentView === 'videos' ? renderVideoListView() : render());
document.getElementById('exportTiersBtn').addEventListener('click', exportTiersCsv);
document.getElementById('importTiersInput').addEventListener('change', (e) => {
  if (e.target.files[0]) importTiersCsv(e.target.files[0]);
});

loadAll();
