const axios  = require("axios");
const http   = require("http");
const url    = require("url");

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/
const QUERY_URL =
  "https://monitor-public.trax-cloud.com/api/datasources/proxy/133/bigquery/v2/projects/trax-ortal-prod/queries";

const FIREBASE_URL  = "https://qat-output-default-rtdb.firebaseio.com";
const FIREBASE_PATH = "/TL Hourly.json";

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// Hardcoded Team Leaders
const TEAM_LEADERS = [
  "G26658-OTL",
  "G25883-OTL",
  "G22371-OTL",
  "G23179- Team Leader"
];

// Staff lookup sheet
const STAFF_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=1860286382&output=csv";

// ══════════════════════════════════════════════════════════════════════
// DENOMINATOR SHEET URL (ඔබගේ URL එක මෙහි යොදන්න)
// ══════════════════════════════════════════════════════════════════════
const DENOMINATOR_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=822634964&output=csv";
// ══════════════════════════════════════════════════════════════════════

/*
|--------------------------------------------------------------------------
| BASIC AUTH
|--------------------------------------------------------------------------
*/
const AUTH_USER = "admin";
const AUTH_PASS = "password123";

function authenticate(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  try {
    const base64 = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64, 'base64').toString('utf8');
    const [user, pass] = credentials.split(':');
    return user === AUTH_USER && pass === AUTH_PASS;
  } catch {
    return false;
  }
}

/*
|--------------------------------------------------------------------------
| GRAFANA SESSION MANAGER
|--------------------------------------------------------------------------
*/
let grafanaSession = null;
let loginPromise = null;

async function loginToGrafana() {
  console.log("🔐 Logging into Grafana...");
  const username = "gss.kurunegala@gssintl.biz";
  const password = "Gssk@2021";
  try {
    const response = await axios.post(
      "https://monitor-public.trax-cloud.com/login",
      { user: username, password: password },
      {
        headers: { "Content-Type": "application/json" },
        maxRedirects: 0,
        validateStatus: (status) => status < 400 || status === 401 || status === 403,
        timeout: 30000
      }
    );
    const setCookieHeader = response.headers['set-cookie'];
    if (setCookieHeader) {
      const cookieArray = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      for (const cookie of cookieArray) {
        const match = cookie.match(/grafana_session=([^;]+)/);
        if (match) {
          grafanaSession = match[1];
          console.log("✅ Grafana session obtained.");
          return grafanaSession;
        }
      }
    }
    throw new Error("grafana_session cookie not found.");
  } catch (error) {
    console.error("❌ Grafana login failed:", error.message);
    throw new Error(`Grafana login failed: ${error.message}`);
  }
}

async function getGrafanaHeaders() {
  if (!grafanaSession) {
    if (!loginPromise) {
      loginPromise = loginToGrafana().finally(() => { loginPromise = null; });
    }
    await loginPromise;
  }
  return {
    "Content-Type": "application/json",
    "Cookie": `grafana_session=${grafanaSession}`
  };
}

async function grafanaRequest(method, url, data = null, retryCount = 0) {
  try {
    const headers = await getGrafanaHeaders();
    const config = { headers, timeout: 30000 };
    let response;
    if (method === 'GET') response = await axios.get(url, config);
    else if (method === 'POST') response = await axios.post(url, data, config);
    return response;
  } catch (error) {
    if (error.response && (error.response.status === 401 || error.response.status === 403) && retryCount < 2) {
      console.warn("⚠️ Session expired. Refreshing...");
      grafanaSession = null;
      loginPromise = null;
      return grafanaRequest(method, url, data, retryCount + 1);
    }
    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| BIGQUERY HELPERS
|--------------------------------------------------------------------------
*/
async function getQueryResults(resultUrl) {
  for (let i = 0; i < 10; i++) {
    const res = await grafanaRequest('GET', resultUrl);
    if (res.data.jobComplete) return res.data;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("BigQuery job timeout");
}

function buildQuery(tlName) {
  return {
    query: `
      #standardSQL
      SELECT
        TIMESTAMP_TRUNC(event_timestamp, HOUR) AS timestamp,
        project_name,
        task_name,
        staff_id,
        SUM(
          CASE
            WHEN LOWER(TRIM(task_name)) = 'stitching' THEN number_of_probes
            ELSE count
          END
        ) AS value
      FROM \`trax-retail.backoffice.tl_hourly_report\`
      WHERE
        event_timestamp BETWEEN
          TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY)
          AND CURRENT_TIMESTAMP()
        AND task_name    IS NOT NULL
        AND project_name IS NOT NULL
        AND team_leader_staff_id = '${tlName}'
      GROUP BY 1, 2, 3, 4
      ORDER BY timestamp
    `,
    useLegacySql: false,
  };
}

function processResults(result) {
  if (!result.rows) return [];
  const fields = result.schema.fields.map(f => f.name);
  return result.rows
    .map(row => {
      const obj = {};
      row.f.forEach((cell, i) => { obj[fields[i]] = cell.v; });
      return obj;
    })
    .filter(obj => {
      const staff = String(obj.staff_id || "").trim().toLowerCase();
      return staff !== "" && staff !== "auto_stitch";
    })
    .map(obj => ({
      timestamp:    obj.timestamp    || "",
      project_name: obj.project_name || "",
      task_name:    obj.task_name    || "",
      staff_id:     obj.staff_id     || "",
      value:        Number(obj.value || 0),
    }));
}

/*
|--------------------------------------------------------------------------
| DENOMINATOR SHEET LOADER (flexible, error-proof)
|--------------------------------------------------------------------------
*/
let denominatorMap = null;

async function loadDenominatorMap() {
  if (denominatorMap !== null) return denominatorMap;
  try {
    console.log("🔄 Loading denominator sheet from:", DENOMINATOR_SHEET_URL);
    const response = await axios.get(DENOMINATOR_SHEET_URL, {
      responseType: 'text',
      timeout: 10000
    });
    const csv = response.data;
    const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) {
      console.warn("⚠️ Denominator sheet empty. Using empty map.");
      denominatorMap = {};
      return denominatorMap;
    }

    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const projIdx = headers.findIndex(h => /project|project_name/i.test(h));
    const taskIdx = headers.findIndex(h => /task|task_name/i.test(h));
    const denoIdx = headers.findIndex(h => /withdeno|denominator|value/i.test(h));

    console.log(`  Columns: Project=${projIdx}, Task=${taskIdx}, Deno=${denoIdx}`);

    if (projIdx === -1 || taskIdx === -1 || denoIdx === -1) {
      console.warn("⚠️ Required columns not found. Using empty map.");
      denominatorMap = {};
      return denominatorMap;
    }

    const map = {};
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      const project = cols[projIdx] || '';
      const task = cols[taskIdx] || '';
      const deno = parseFloat(cols[denoIdx]) || 0;
      if (project && task) {
        const key = `${project}__${task}`;
        map[key] = deno;
      }
    }
    denominatorMap = map;
    console.log(`✅ Denominator map loaded: ${Object.keys(map).length} entries`);
    return map;
  } catch (err) {
    console.error("❌ Failed to load denominator sheet:", err.message);
    denominatorMap = {};
    return denominatorMap;
  }
}

/*
|--------------------------------------------------------------------------
| FETCH SINGLE TL (with withdeno & withoutdeno)
|--------------------------------------------------------------------------
*/
async function fetchSingleTL(tlName) {
  console.log(`  Fetching: tl_name="${tlName}"`);

  // 1. BigQuery data
  const query = buildQuery(tlName);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const jobId = response.data.jobReference.jobId;
  const location = response.data.jobReference.location;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(resultUrl);
  const rows = processResults(result);
  console.log(`    BigQuery rows: ${rows.length}`);

  // 2. Load denominator map (always returns an object)
  let denoMap = await loadDenominatorMap();

  // 3. Count rows per hour per project/task
  const hourCounts = {};
  rows.forEach(row => {
    const key = `${row.timestamp}__${row.project_name}__${row.task_name}`;
    if (!hourCounts[key]) hourCounts[key] = 0;
    hourCounts[key] += 1;
  });

  // 4. Calculate WD (withdeno) and WO (previous total) and also keep without deno
  const sortedRows = [...rows].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const staffPrevValue = {};

  const enhancedRows = sortedRows.map(row => {
    const hourKey = `${row.timestamp}__${row.project_name}__${row.task_name}`;
    const count = hourCounts[hourKey] || 0;
    const denoKey = `${row.project_name}__${row.task_name}`;
    const deno = denoMap[denoKey] || 0;

    // ---- withdeno = deno * count ----
    let wd_withdeno = deno * count;
    // 5:30 AM WD is empty (set to 0 to show as blank later)
    const date = new Date(row.timestamp);
    const hour = date.getHours();
    const minutes = date.getMinutes();
    if (hour === 5 && minutes === 30) {
      wd_withdeno = 0;
    }

    // ---- withoutdeno = original value (sum) ----
    const wd_withoutdeno = row.value;

    // ---- WO = previous hour's total for this staff ----
    const staffId = row.staff_id;
    const prevTotal = staffPrevValue[staffId] || 0;
    const wo = prevTotal;

    // Update for next hour
    staffPrevValue[staffId] = (staffPrevValue[staffId] || 0) + row.value;

    return {
      ...row,
      wd_withdeno: wd_withdeno,        // with denominator
      wd_withoutdeno: wd_withoutdeno,  // without denominator (raw value)
      wo: wo,                          // previous hour's total
    };
  });

  return {
    tl_name: tlName,
    rows: enhancedRows,
    total_rows: enhancedRows.length,
    fetched_at: new Date().toISOString()
  };
}

/*
|--------------------------------------------------------------------------
| FETCH ALL
|--------------------------------------------------------------------------
*/
async function fetchAllTeamLeaders() {
  console.log(`\n>>> Fetching data for ${TEAM_LEADERS.length} Team Leaders...`);
  const results = await Promise.all(
    TEAM_LEADERS.map(async (tlName) => {
      try {
        return await fetchSingleTL(tlName);
      } catch (err) {
        console.error(`  Error fetching ${tlName}:`, err.message);
        return {
          tl_name: tlName,
          error: err.message,
          rows: [],
          total_rows: 0,
          fetched_at: new Date().toISOString()
        };
      }
    })
  );
  console.log(`\nTotal: ${results.length} team leaders processed`);
  return results;
}

/*
|--------------------------------------------------------------------------
| FIREBASE SAVE
|--------------------------------------------------------------------------
*/
async function saveToFirebase(allData) {
  const payload = {
    updated_at:    new Date().toISOString(),
    total_leaders: allData.length,
    data:          allData
  };
  await axios.put(`${FIREBASE_URL}${FIREBASE_PATH}`, payload);
  console.log(`  Firebase updated: ${allData.length} team leaders data`);
}

/*
|--------------------------------------------------------------------------
| STAFF LOOKUP
|--------------------------------------------------------------------------
*/
async function fetchStaffLookup() {
  try {
    const response = await axios.get(STAFF_SHEET_URL, { responseType: 'text' });
    return response.data;
  } catch (err) {
    console.error('Staff lookup error:', err.message);
    throw new Error('Failed to fetch staff sheet: ' + err.message);
  }
}

/*
|--------------------------------------------------------------------------
| HTTP SERVER
|--------------------------------------------------------------------------
*/
const server = http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

  if (!authenticate(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="QAT Server"',
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    if (pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "QAT Server", time: new Date().toISOString() }));
      return;
    }

    if (pathname === "/fetch-all" && req.method === "GET") {
      const allData = await fetchAllTeamLeaders();
      await saveToFirebase(allData);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: allData,
        total_leaders: allData.length,
        updated_at: new Date().toISOString()
      }));
      return;
    }

    if (pathname === "/fetch" && req.method === "GET") {
      const tlName = (parsed.query.tl_name || TEAM_LEADERS[0]).trim();
      const data = await fetchSingleTL(tlName);
      const payload = {
        updated_at:    new Date().toISOString(),
        total_rows:    data.total_rows,
        filter_config: { tl_name: tlName },
        data:          data.rows,
      };
      await axios.put(`${FIREBASE_URL}${FIREBASE_PATH}`, payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        rows: data.rows,
        total: data.total_rows,
        tl_name: tlName,
        updated_at: new Date().toISOString(),
      }));
      return;
    }

    if (pathname === "/staff-lookup" && req.method === "GET") {
      const csv = await fetchStaffLookup();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ csv }));
      return;
    }

    if (pathname === "/team-leaders" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        team_leaders: TEAM_LEADERS,
        count: TEAM_LEADERS.length
      }));
      return;
    }

    res.writeHead(404); res.end("Not found");
  } catch (error) {
    console.error("❌ Server Error:", error.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ 
      error: error.message,
      details: error.stack
    }));
  }
});

server.listen(PORT, HOST, () => {
  console.log("================================");
  console.log(`  QAT Server running on http://${HOST}:${PORT}`);
  console.log(`  Basic Auth: ${AUTH_USER} / ${AUTH_PASS}`);
  console.log("  Grafana credentials: hardcoded (auto-renewal)");
  console.log("  Denominator sheet loaded on first request (fallback to empty map)");
  console.log("  Fields: wd_withdeno, wd_withoutdeno, wo");
  console.log("================================");
});
