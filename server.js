const axios = require("axios");
const http = require("http");
const url = require("url");

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/
const QUERY_URL =
  "https://monitor-public.trax-cloud.com/api/datasources/proxy/133/bigquery/v2/projects/trax-ortal-prod/queries";

const FIREBASE_URL = "https://qat-output-default-rtdb.firebaseio.com";
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

// Project/Task lookup sheet
const PROJECT_TASK_SHEET_URL = () =>
  `https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=822634964&output=csv&_=${Date.now()}`;

// Denominator Sheet URL
const DENOMINATOR_SHEET_URL = () =>
  `https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=0&output=csv&_=${Date.now()}`;

/*
|--------------------------------------------------------------------------
| HARDCODED BASIC AUTH
|--------------------------------------------------------------------------
*/
const AUTH_USER = "admin";
const AUTH_PASS = "password123";

/*
|--------------------------------------------------------------------------
| CORS HEADERS
|--------------------------------------------------------------------------
*/
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Accept",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Max-Age": "86400"
};

function setCorsHeaders(res) {
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

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
  console.log("🔐 Logging into Grafana to get fresh session...");

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

    console.log(`  Login response status: ${response.status}`);

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

    throw new Error("Login successful but grafana_session cookie not found in response.");
  } catch (error) {
    console.error("❌ Grafana login failed:", error.message);
    if (error.response) {
      console.error("  Response status:", error.response.status);
      console.error("  Response data:", error.response.data);
    }
    throw new Error(`Grafana login failed: ${error.message}`);
  }
}

async function getGrafanaHeaders() {
  if (!grafanaSession) {
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

async function grafanaRequest(method, url, data = null, retryCount = 0) {
  try {
    const headers = await getGrafanaHeaders();
    const config = { headers, timeout: 30000 };
    let response;
    if (method === 'GET') {
      response = await axios.get(url, config);
    } else if (method === 'POST') {
      response = await axios.post(url, data, config);
    }
    return response;
  } catch (error) {
    if (error.response && (error.response.status === 401 || error.response.status === 403) && retryCount < 2) {
      console.warn("⚠️ Session expired or invalid. Refreshing Grafana session...");
      grafanaSession = null;
      loginPromise = null;
      return grafanaRequest(method, url, data, retryCount + 1);
    }
    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| BIGQUERY
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
      timestamp: obj.timestamp || "",
      project_name: obj.project_name || "",
      task_name: obj.task_name || "",
      staff_id: obj.staff_id || "",
      value: Number(obj.value || 0),
    }));
}

/*
|--------------------------------------------------------------------------
| FIREBASE
|--------------------------------------------------------------------------
*/
async function saveToFirebase(allData) {
  const payload = {
    updated_at: new Date().toISOString(),
    total_leaders: allData.length,
    data: allData
  };
  await axios.put(`${FIREBASE_URL}${FIREBASE_PATH}`, payload);
  console.log(`  Firebase updated: ${allData.length} team leaders data`);
}

/*
|--------------------------------------------------------------------------
| DENOMINATOR LOOKUP
|--------------------------------------------------------------------------
*/
// Cache for denominator data
let denominatorCache = {
  data: null,
  byProjectTask: {},
  byGID: {},
  timestamp: null,
  cacheDuration: 5 * 60 * 1000 // 5 minutes
};

async function fetchDenominatorSheet() {
  try {
    console.log("📊 Fetching denominator sheet...");
    const response = await axios.get(DENOMINATOR_SHEET_URL(), {
      responseType: 'text',
      timeout: 30000
    });

    const lines = response.data.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) return {};

    const splitLine = (line) =>
      line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));

    const headers = splitLine(lines[0]).map(h => h.toLowerCase());
    
    // Find column indices
    const projectIdx = headers.findIndex(h => h.includes('project'));
    const taskIdx = headers.findIndex(h => h.includes('task'));
    const gidIdx = headers.findIndex(h => h.includes('gid') || h.includes('staff_id'));
    const denominatorIdx = headers.findIndex(h => h.includes('denominator') || h.includes('denom'));
    
    const denominatorMap = {
      byProjectTask: {},
      byGID: {}
    };

    for (let i = 1; i < lines.length; i++) {
      const cells = splitLine(lines[i]);
      const project = cells[projectIdx] || '';
      const task = cells[taskIdx] || '';
      const gid = cells[gidIdx] || '';
      const denominator = parseFloat(cells[denominatorIdx]) || 1;

      // Store by Project + Task combination
      const key = `${project}__${task}`;
      if (project && task) {
        denominatorMap.byProjectTask[key] = denominator;
      }

      // Store by GID
      if (gid) {
        denominatorMap.byGID[gid] = denominator;
      }
    }

    console.log(`✅ Loaded ${Object.keys(denominatorMap.byProjectTask).length} project/task denominators`);
    console.log(`✅ Loaded ${Object.keys(denominatorMap.byGID).length} GID denominators`);
    
    return denominatorMap;
  } catch (err) {
    console.error("❌ Failed to fetch denominator sheet:", err.message);
    return { byProjectTask: {}, byGID: {} };
  }
}

async function getDenominatorData(forceRefresh = false) {
  const now = Date.now();
  
  if (!forceRefresh && 
      denominatorCache.data && 
      denominatorCache.timestamp && 
      (now - denominatorCache.timestamp) < denominatorCache.cacheDuration) {
    return denominatorCache.data;
  }
  
  const data = await fetchDenominatorSheet();
  denominatorCache.data = data;
  denominatorCache.timestamp = now;
  return data;
}

function lookupDenominator(project, task, gid, denominatorData) {
  // Default value based on task type
  let defaultValue = 1;
  
  // Special cases
  const taskLower = (task || "").toLowerCase().trim();
  if (['stitching', 'stitching_edit'].includes(taskLower)) {
    return 0;
  }
  if (['offline_posm', 'scene_recognition'].includes(taskLower)) {
    defaultValue = 0.5;
  }
  if (taskLower === 'validation_warm_up') {
    defaultValue = 0.35;
  }

  // First try by GID
  if (gid && denominatorData.byGID[gid]) {
    return denominatorData.byGID[gid];
  }

  // Then try by Project + Task
  const key = `${project}__${task}`;
  if (project && task && denominatorData.byProjectTask[key]) {
    return denominatorData.byProjectTask[key];
  }

  // Return default value
  return defaultValue;
}

/*
|--------------------------------------------------------------------------
| FETCH SINGLE TL with Denominator
|--------------------------------------------------------------------------
*/
async function fetchSingleTL(tlName) {
  console.log(`  Fetching: tl_name="${tlName}"`);
  const query = buildQuery(tlName);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const jobId = response.data.jobReference.jobId;
  const location = response.data.jobReference.location;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(resultUrl);
  let rows = processResults(result);
  
  console.log(`    Rows found: ${rows.length}`);

  // Get denominator data
  const denominatorData = await getDenominatorData();

  // Enrich rows with denominator and calculate WD
  // W/O will be calculated in frontend using the raw count
  rows = rows.map(row => {
    const denominator = lookupDenominator(
      row.project_name,
      row.task_name,
      row.staff_id,
      denominatorData
    );
    
    // WD = value * denominator
    const wd = row.value * denominator;
    
    return {
      ...row,
      denominator: denominator,
      wd: wd,
      // W/O will be calculated in frontend using the raw count (value)
      // Not multiplied by denominator
      count: row.value // Keep raw count for W/O calculation
    };
  });

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
| PROJECT/TASK LOOKUP
|--------------------------------------------------------------------------
*/
async function fetchProjectTaskLookup() {
  try {
    console.log("📊 Fetching project/task lookup data...");
    const response = await axios.get(PROJECT_TASK_SHEET_URL(), {
      responseType: 'text',
      timeout: 30000
    });

    const lines = response.data.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) return [];

    const splitLine = (line) =>
      line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));

    const headers = splitLine(lines[0]).map(h => h.toLowerCase());
    const records = [];

    for (let i = 1; i < lines.length; i++) {
      const cells = splitLine(lines[i]);
      const record = {};
      headers.forEach((header, idx) => {
        record[header] = cells[idx] || '';
      });
      records.push(record);
    }

    console.log(`✅ Loaded ${records.length} project/task lookup records`);
    return records;
  } catch (err) {
    console.error("❌ Failed to fetch project/task lookup:", err.message);
    throw new Error("Failed to fetch project/task sheet: " + err.message);
  }
}

/*
|--------------------------------------------------------------------------
| HTTP SERVER WITH CORS
|--------------------------------------------------------------------------
*/
const server = http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);

  // Set CORS headers for ALL responses
  setCorsHeaders(res);

  // Handle preflight OPTIONS request immediately
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Basic Auth check
  if (!authenticate(req)) {
    console.log(`  ❌ Unauthorized: ${req.url}`);
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="QAT Server"',
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    // Health check
    if (pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        service: "QAT Server",
        time: new Date().toISOString(),
        cors: "enabled"
      }));
      return;
    }

    // Fetch all team leaders
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

    // Fetch single team leader
    if (pathname === "/fetch" && req.method === "GET") {
      const tlName = (parsed.query.tl_name || TEAM_LEADERS[0]).trim();
      const data = await fetchSingleTL(tlName);
      const payload = {
        updated_at: new Date().toISOString(),
        total_rows: data.total_rows,
        filter_config: { tl_name: tlName },
        data: data.rows,
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

    // Staff lookup
    if (pathname === "/staff-lookup" && req.method === "GET") {
      const csv = await fetchStaffLookup();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ csv }));
      return;
    }

    // Project/Task lookup
    if (pathname === "/project-task-lookup" && req.method === "GET") {
      try {
        const data = await fetchProjectTaskLookup();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          data: data,
          count: data.length
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: err.message
        }));
      }
      return;
    }

    // Denominator lookup
    if (pathname === "/denominator-lookup" && req.method === "GET") {
      try {
        const data = await getDenominatorData(true);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          data: data,
          count: {
            byProjectTask: Object.keys(data.byProjectTask).length,
            byGID: Object.keys(data.byGID).length
          }
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: err.message
        }));
      }
      return;
    }

    // Team leaders list
    if (pathname === "/team-leaders" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        team_leaders: TEAM_LEADERS,
        count: TEAM_LEADERS.length
      }));
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    console.error("❌ Server Error:", error.message);
    console.error("  Stack:", error.stack);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: error.message,
      details: error.stack
    }));
  }
});

// Start server
server.listen(PORT, HOST, () => {
  console.log("================================");
  console.log(`  🚀 QAT Server running on http://${HOST}:${PORT}`);
  console.log(`  🔐 Basic Auth: ${AUTH_USER} / ${AUTH_PASS}`);
  console.log(`  🌐 CORS: Enabled for all origins`);
  console.log(`  📊 Endpoints:`);
  console.log(`    GET  /                        - Health check`);
  console.log(`    GET  /fetch-all               - Fetch all team leaders`);
  console.log(`    GET  /fetch?tl_name=          - Fetch single team leader`);
  console.log(`    GET  /staff-lookup            - Staff name lookup`);
  console.log(`    GET  /project-task-lookup     - Project/Task lookup`);
  console.log(`    GET  /denominator-lookup      - Denominator lookup`);
  console.log(`    GET  /team-leaders            - List of team leaders`);
  console.log("================================");
});
