const axios  = require("axios");
const http   = require("http");
const url    = require("url");

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/
const GRAFANA_SESSION = "dd97072a6c45dfb5be4cca947d39664a";

const QUERY_URL =
  "https://monitor-public.trax-cloud.com/api/datasources/proxy/133/bigquery/v2/projects/trax-ortal-prod/queries";

const FIREBASE_URL  = "https://qat-output-default-rtdb.firebaseio.com";
const FIREBASE_PATH = "/TL Hourly.json";

const PORT = 3000;

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

const headers = {
  "Content-Type": "application/json",
  "Cookie": `grafana_session=${GRAFANA_SESSION}`,
};

/*
|--------------------------------------------------------------------------
| BIGQUERY — poll until job complete
|--------------------------------------------------------------------------
*/
async function getQueryResults(resultUrl) {
  for (let i = 0; i < 10; i++) {
    const res = await axios.get(resultUrl, { headers });
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

  const query    = buildQuery(tlName);
  const response = await axios.post(QUERY_URL, query, { headers });

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
| FETCH ALL TEAM LEADERS DATA
|--------------------------------------------------------------------------
*/
async function fetchAllTeamLeaders() {
  console.log(`\n>>> Fetching data for ${TEAM_LEADERS.length} Team Leaders...`);
  
  const results = [];
  
  for (const tlName of TEAM_LEADERS) {
    try {
      const data = await fetchSingleTL(tlName);
      results.push(data);
    } catch (err) {
      console.error(`  Error fetching ${tlName}:`, err.message);
      results.push({
        tl_name: tlName,
        error: err.message,
        rows: [],
        total_rows: 0,
        fetched_at: new Date().toISOString()
      });
    }
  }
  
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

server.listen(PORT, () => {
  console.log("================================");
  console.log(`  QAT Server running`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Team Leaders (${TEAM_LEADERS.length}):`);
  TEAM_LEADERS.forEach(tl => console.log(`    - ${tl}`));
  console.log("================================");
  console.log("  Endpoints:");
  console.log(`  GET /fetch-all           - Fetch all team leaders data`);
  console.log(`  GET /fetch?tl_name=...   - Fetch specific team leader`);
  console.log(`  GET /team-leaders        - Get list of all team leaders`);
  console.log(`  GET /staff-lookup        - Get staff lookup CSV`);
  console.log("================================");
  console.log("  Open index.html in browser");
  console.log("================================\n");
});