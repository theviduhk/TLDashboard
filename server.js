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

// Railway port config
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// Team Leaders
const TEAM_LEADERS = [
  "G26658-OTL",
  "G25883-OTL",
  "G22371-OTL",
  "G23179- Team Leader"
];

// Staff lookup sheet
const STAFF_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=1860286382&output=csv";

/*
|--------------------------------------------------------------------------
| HARDCODED BASIC AUTH (frontend ආරක්ෂාව සඳහා)
|--------------------------------------------------------------------------
*/
const AUTH_USER = "admin";
const AUTH_PASS = "password123";

function authenticate(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  const base64 = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64, 'base64').toString('utf8');
  const [user, pass] = credentials.split(':');
  return user === AUTH_USER && pass === AUTH_PASS;
}

/*
|--------------------------------------------------------------------------
| GRAFANA SESSION MANAGER (Auto-login & Retry)
|--------------------------------------------------------------------------
*/

// Dynamic headers - session එක මෙතන ගබඩා වේ
let grafanaSession = null;
let loginPromise = null; // එකවර login requests ගොඩක් යැවීම වළක්වයි

/**
 * Grafana login කර නව session cookie එකක් ලබා ගනී
 * ⚠️ පහත පේළි දෙකේ ඔබගේ සැබෑ Grafana ගිණුම් නාමය සහ මුරපදය ඇතුලත් කරන්න
 */
async function loginToGrafana() {
  console.log("🔐 Logging into Grafana to get fresh session...");

  // ---------- HARDCODED GRAFANA CREDENTIALS ----------
  const username = "YOUR_GRAFANA_USERNAME_HERE";  // <-- මෙය වෙනස් කරන්න
  const password = "YOUR_GRAFANA_PASSWORD_HERE";  // <-- මෙය වෙනස් කරන්න
  // --------------------------------------------------

  try {
    const response = await axios.post(
      "https://monitor-public.trax-cloud.com/login",
      { user: username, password: password },
      {
        headers: { "Content-Type": "application/json" },
        maxRedirects: 0, // Redirects අපිට අවශ්‍ය නැත
        validateStatus: (status) => status < 400 || status === 401 || status === 403
      }
    );

    // Set-Cookie header එකෙන් grafana_session එක උකහා ගනිමු
    const setCookieHeader = response.headers['set-cookie'];
    if (setCookieHeader) {
      const cookieArray = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      for (const cookie of cookieArray) {
        const match = cookie.match(/grafana_session=([^;]+)/);
        if (match) {
          grafanaSession = match[1];
          console.log("✅ New Grafana session obtained successfully!");
          return grafanaSession;
        }
      }
    }

    // යම් හේතුවකින් session එක නොලැබුනහොත්
    throw new Error("Login successful but grafana_session cookie not found in response.");
  } catch (error) {
    console.error("❌ Grafana login failed:", error.message);
    throw new Error("Failed to authenticate with Grafana");
  }
}

/**
 * Current headers ලබා ගනී. session එක null නම් auto-login වේ.
 */
async function getGrafanaHeaders() {
  if (!grafanaSession) {
    // Login කරන තෙක් ඉන්න (concurrent calls එකට හසු නොවීමට)
    if (!loginPromise) {
      loginPromise = loginToGrafana().finally(() => {
        loginPromise = null;
      });
    }
    await loginPromise;
  }
  return {
    "Content-Type": "application/json",
    "Cookie": `grafana_session=${grafanaSession}`
  };
}

/**
 * Grafana request එකක් execute කරයි. 401/403 error එකක් ආවොත් session එක refresh කර නැවත try කරයි.
 */
async function grafanaRequest(method, url, data = null, retryCount = 0) {
  const headers = await getGrafanaHeaders();
  
  try {
    const config = { headers, timeout: 30000 };
    let response;
    if (method === 'GET') {
      response = await axios.get(url, config);
    } else if (method === 'POST') {
      response = await axios.post(url, data, config);
    }
    return response;
  } catch (error) {
    // Unauthorized හෝ Forbidden ආවොත්, session එක reset කර නැවත login කර try කරමු
    if ((error.response && (error.response.status === 401 || error.response.status === 403)) && retryCount < 2) {
      console.warn("⚠️ Session expired or invalid. Refreshing Grafana session...");
      grafanaSession = null; // Old session එක invalid කරමු
      loginPromise = null;   // නැවත login වීමට ඉඩ දෙමු
      // නැවත උත්සාහ කරමු (retry +1)
      return grafanaRequest(method, url, data, retryCount + 1);
    }
    // වෙනත් error එකක් නම් හෝ retry count ඉක්මවුනොත් throw කරමු
    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| BIGQUERY — poll until job complete (with auto-session)
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

/*
|--------------------------------------------------------------------------
| BUILD SQL
|--------------------------------------------------------------------------
*/
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

/*
|--------------------------------------------------------------------------
| PROCESS ROWS
|--------------------------------------------------------------------------
*/
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
| FIREBASE
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
| FETCH SINGLE TL
|--------------------------------------------------------------------------
*/
async function fetchSingleTL(tlName) {
  console.log(`  Fetching: tl_name="${tlName}"`);
  const query    = buildQuery(tlName);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const jobId    = response.data.jobReference.jobId;
  const location = response.data.jobReference.location;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(resultUrl);
  const rows   = processResults(result);
  console.log(`    Rows found: ${rows.length}`);
  return {
    tl_name: tlName,
    rows: rows,
    total_rows: rows.length,
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

  // Basic Auth (frontend ආරක්ෂාව)
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

  if (pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "QAT Server", time: new Date().toISOString() }));
    return;
  }

  if (pathname === "/fetch-all" && req.method === "GET") {
    try {
      const allData = await fetchAllTeamLeaders();
      await saveToFirebase(allData);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: allData,
        total_leaders: allData.length,
        updated_at: new Date().toISOString()
      }));
    } catch (err) {
      console.error("Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === "/fetch" && req.method === "GET") {
    const tlName = (parsed.query.tl_name || TEAM_LEADERS[0]).trim();
    try {
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
    } catch (err) {
      console.error("Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === "/staff-lookup" && req.method === "GET") {
    try {
      const csv = await fetchStaffLookup();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ csv }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
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
});

server.listen(PORT, HOST, () => {
  console.log("================================");
  console.log(`  QAT Server running on http://${HOST}:${PORT}`);
  console.log(`  Basic Auth: ${AUTH_USER} / ${AUTH_PASS}`);
  console.log("  Grafana session: Auto-renewal enabled (credentials hardcoded)");
  console.log("================================");
});
