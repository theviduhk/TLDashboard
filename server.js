const axios  = require("axios");
const http   = require("http");
const url    = require("url");

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

// Grafana base URL — used both for login and as the proxy host for BigQuery
const GRAFANA_BASE_URL = "https://monitor-public.trax-cloud.com";

// Credentials come from environment variables — NEVER hardcode them here.
// Set these in Railway: Project → Variables → GRAFANA_USER / GRAFANA_PASSWORD
const GRAFANA_USER     = process.env.GRAFANA_USER;
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD;

const QUERY_URL =
  `${GRAFANA_BASE_URL}/api/datasources/proxy/133/bigquery/v2/projects/trax-ortal-prod/queries`;

const FIREBASE_URL  = "https://qat-output-default-rtdb.firebaseio.com";
const FIREBASE_PATH = "/TL Hourly.json";

// Railway (and most hosts) assign a dynamic port via the PORT env var.
// Falling back to 3000 keeps this working for local development too.
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0"; // must bind to all interfaces, not just localhost, for Railway to route traffic in

// List of all Team Leaders to fetch data for
const TEAM_LEADERS = [
  "G26658-OTL",
  "G25883-OTL",
  "G22371-OTL",
  "G23179- Team Leader"
];

// Google Sheet URL for staff lookup
const STAFF_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=1860286382&output=csv";

/*
|--------------------------------------------------------------------------
| GRAFANA SESSION — auto login + auto re-login on expiry
|--------------------------------------------------------------------------
*/

let cachedSessionCookie = null; // e.g. "grafana_session=abcd1234"

async function loginToGrafana() {
  if (!GRAFANA_USER || !GRAFANA_PASSWORD) {
    throw new Error(
      "GRAFANA_USER / GRAFANA_PASSWORD environment variables are not set. " +
      "Add them in Railway → Variables."
    );
  }

  console.log("  Logging into Grafana...");

  const response = await axios.post(
    `${GRAFANA_BASE_URL}/login`,
    { user: GRAFANA_USER, password: GRAFANA_PASSWORD },
    { headers: { "Content-Type": "application/json" } }
  );

  const setCookieHeaders = response.headers["set-cookie"];
  if (!setCookieHeaders) {
    throw new Error("Grafana login did not return any cookies — check the username/password.");
  }

  const sessionCookieHeader = setCookieHeaders.find(c => c.startsWith("grafana_session="));
  if (!sessionCookieHeader) {
    throw new Error("grafana_session cookie was not found in the Grafana login response.");
  }

  // Keep only the "grafana_session=xxxx" part, drop attributes like Path/HttpOnly/Expires
  cachedSessionCookie = sessionCookieHeader.split(";")[0];

  console.log("  Grafana session refreshed");
  return cachedSessionCookie;
}

async function getSessionCookie() {
  if (!cachedSessionCookie) {
    await loginToGrafana();
  }
  return cachedSessionCookie;
}

// Wraps any axios call to the Grafana-proxied BigQuery API.
// If the session has expired (401/403), it logs in again once and retries.
async function grafanaRequest(config) {
  const cookie = await getSessionCookie();

  try {
    return await axios({
      ...config,
      headers: { ...config.headers, Cookie: cookie },
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      console.log("  Session expired — re-authenticating with Grafana...");
      const freshCookie = await loginToGrafana();
      return await axios({
        ...config,
        headers: { ...config.headers, Cookie: freshCookie },
      });
    }
    throw err;
  }
}

/*
|--------------------------------------------------------------------------
| BIGQUERY — poll until job complete
|--------------------------------------------------------------------------
*/
async function getQueryResults(resultUrl) {
  for (let i = 0; i < 10; i++) {
    const res = await grafanaRequest({ method: "get", url: resultUrl });
    if (res.data.jobComplete) return res.data;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("BigQuery job timeout");
}

/*
|--------------------------------------------------------------------------
| BUILD SQL — filter by team_leader_staff_id, all projects + all tasks returned
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
| PROCESS ROWS — keeps only real staff_id rows (drops blank / auto_stitch)
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
| SAVE TO FIREBASE - Now saves data for all team leaders
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
| FETCH DATA FOR SINGLE TEAM LEADER
|--------------------------------------------------------------------------
*/
async function fetchSingleTL(tlName) {
  console.log(`  Fetching: tl_name="${tlName}"`);

  const query = buildQuery(tlName);
  const response = await grafanaRequest({
    method: "post",
    url: QUERY_URL,
    data: query,
    headers: { "Content-Type": "application/json" },
  });

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
| FETCH ALL TEAM LEADERS DATA — runs in parallel to avoid gateway timeouts
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
| STAFF LOOKUP — fetch Google Sheet CSV and return it
|--------------------------------------------------------------------------
*/
async function fetchStaffLookup() {
  try {
    const response = await axios.get(STAFF_SHEET_URL, {
      responseType: 'text',
    });
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
  // CORS — allow requests from your frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // GET / - simple health check so Railway / uptime monitors get a 200
  if (pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "QAT Server", time: new Date().toISOString() }));
    return;
  }

  // GET /fetch-all - fetches data for ALL team leaders
  if (pathname === "/fetch-all" && req.method === "GET") {
    try {
      const allData = await fetchAllTeamLeaders();

      // Save to Firebase
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

  // GET /fetch?tl_name=G26658-OTL - fetches data for a specific team leader (maintained for backward compatibility)
  if (pathname === "/fetch" && req.method === "GET") {
    const tlName = (parsed.query.tl_name || TEAM_LEADERS[0]).trim();

    try {
      const data = await fetchSingleTL(tlName);

      // Save to Firebase in old format for backward compatibility
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

  // GET /staff-lookup — returns the CSV from Google Sheet as JSON { csv: "..." }
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

  // GET /team-leaders - returns the list of all team leaders
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
  console.log(`  QAT Server running`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  Grafana auth: ${GRAFANA_USER ? "env vars set" : "MISSING — set GRAFANA_USER / GRAFANA_PASSWORD"}`);
  console.log(`  Team Leaders (${TEAM_LEADERS.length}):`);
  TEAM_LEADERS.forEach(tl => console.log(`    - ${tl}`));
  console.log("================================");
  console.log("  Endpoints:");
  console.log(`  GET /                    - Health check`);
  console.log(`  GET /fetch-all           - Fetch all team leaders data`);
  console.log(`  GET /fetch?tl_name=...   - Fetch specific team leader`);
  console.log(`  GET /team-leaders        - Get list of all team leaders`);
  console.log(`  GET /staff-lookup        - Get staff lookup CSV`);
  console.log("================================\n");
});
