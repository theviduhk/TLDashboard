const axios = require("axios");
const { parse } = require("csv-parse/sync");

// Your existing sheet URL for staff
const STAFF_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=1860286382&output=csv";

// The new sheet URL for project and task data
const PROJECT_TASK_SHEET_URL = () =>
    `https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=822634964&output=csv&_=${Date.now()}`;

// Cache for the lookup data to avoid frequent sheet reads
let lookupCache = {
  data: null,
  timestamp: null,
  cacheDuration: 5 * 60 * 1000 // 5 minutes cache
};

/**
 * Fetch and parse the project/task lookup sheet
 * Returns an array of objects with project_name, task_name, and other fields
 */
async function fetchProjectTaskLookup() {
  try {
    console.log("📊 Fetching project/task lookup data...");
    const response = await axios.get(PROJECT_TASK_SHEET_URL(), {
      responseType: 'text',
      timeout: 30000
    });
    
    // Parse CSV to array of objects
    const records = parse(response.data, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
    
    console.log(`✅ Loaded ${records.length} lookup records`);
    return records;
  } catch (err) {
    console.error("❌ Failed to fetch project/task lookup:", err.message);
    throw new Error("Failed to fetch project/task sheet: " + err.message);
  }
}

/**
 * Get project/task lookup data with caching
 */
async function getProjectTaskLookup(forceRefresh = false) {
  const now = Date.now();
  
  // Check if cache is valid
  if (!forceRefresh && 
      lookupCache.data && 
      lookupCache.timestamp && 
      (now - lookupCache.timestamp) < lookupCache.cacheDuration) {
    console.log("📦 Using cached lookup data");
    return lookupCache.data;
  }
  
  // Fetch fresh data
  const data = await fetchProjectTaskLookup();
  lookupCache.data = data;
  lookupCache.timestamp = now;
  return data;
}

/**
 * Lookup project and task information based on staff_id and/or project_name
 * @param {string} staffId - The staff ID to lookup
 * @param {string} projectName - Optional project name to filter
 * @param {string} taskName - Optional task name to filter
 * @returns {Object} - Matching records with project and task details
 */
async function lookupProjectTask(staffId, projectName = null, taskName = null) {
  try {
    const lookupData = await getProjectTaskLookup();
    
    // Normalize inputs
    const normalizedStaffId = staffId?.trim().toLowerCase() || "";
    const normalizedProject = projectName?.trim().toLowerCase() || "";
    const normalizedTask = taskName?.trim().toLowerCase() || "";
    
    // Filter records
    let results = lookupData.filter(record => {
      const recordStaffId = (record.staff_id || record.staffId || "").trim().toLowerCase();
      const recordProject = (record.project_name || record.projectName || "").trim().toLowerCase();
      const recordTask = (record.task_name || record.taskName || "").trim().toLowerCase();
      
      // Check staff ID match
      const staffMatch = normalizedStaffId ? recordStaffId.includes(normalizedStaffId) : true;
      
      // Check project name match if provided
      const projectMatch = normalizedProject ? 
        recordProject.includes(normalizedProject) : true;
      
      // Check task name match if provided
      const taskMatch = normalizedTask ? 
        recordTask.includes(normalizedTask) : true;
      
      return staffMatch && projectMatch && taskMatch;
    });
    
    console.log(`🔍 Found ${results.length} matches for staff: ${staffId || 'all'}`);
    return results;
  } catch (err) {
    console.error("❌ Lookup error:", err.message);
    throw err;
  }
}

/**
 * Get all projects associated with a specific staff ID
 */
async function getProjectsForStaff(staffId) {
  const results = await lookupProjectTask(staffId);
  const projects = [...new Set(results.map(r => r.project_name || r.projectName))];
  return projects;
}

/**
 * Get all tasks for a specific staff ID and project
 */
async function getTasksForStaffProject(staffId, projectName) {
  const results = await lookupProjectTask(staffId, projectName);
  const tasks = [...new Set(results.map(r => r.task_name || r.taskName))];
  return tasks;
}

/**
 * Validate if a staff ID exists in the lookup sheet
 */
async function validateStaff(staffId) {
  const results = await lookupProjectTask(staffId);
  return results.length > 0;
}

/**
 * Get aggregated summary for a staff member
 */
async function getStaffSummary(staffId) {
  const results = await lookupProjectTask(staffId);
  
  const summary = {
    staff_id: staffId,
    total_projects: 0,
    total_tasks: 0,
    projects: {},
    tasks: [],
    records: results
  };
  
  results.forEach(record => {
    const project = record.project_name || record.projectName;
    const task = record.task_name || record.taskName;
    
    if (project) {
      if (!summary.projects[project]) {
        summary.projects[project] = [];
        summary.total_projects++;
      }
      if (task && !summary.projects[project].includes(task)) {
        summary.projects[project].push(task);
        summary.total_tasks++;
      }
    }
    
    if (task && !summary.tasks.includes(task)) {
      summary.tasks.push(task);
    }
  });
  
  return summary;
}

// Example usage in your HTTP server
async function addLookupEndpoints(server) {
  // Endpoint to get project/task lookup data
  server.on('request', async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    
    // Add new endpoints
    if (pathname === "/project-task-lookup" && req.method === "GET") {
      try {
        const staffId = parsed.query.staff_id || "";
        const projectName = parsed.query.project_name || null;
        const taskName = parsed.query.task_name || null;
        
        let data;
        if (staffId) {
          data = await lookupProjectTask(staffId, projectName, taskName);
        } else {
          data = await getProjectTaskLookup();
        }
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          data: data,
          count: data.length,
          filters: { staffId, projectName, taskName }
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
    
    // Endpoint to get staff summary
    if (pathname === "/staff-summary" && req.method === "GET") {
      try {
        const staffId = parsed.query.staff_id;
        if (!staffId) {
          throw new Error("staff_id parameter required");
        }
        
        const summary = await getStaffSummary(staffId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          summary: summary
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
  });
}

// Example: Use the lookup with your existing fetchSingleTL function
async function fetchSingleTLWithLookup(tlName) {
  console.log(`  Fetching: tl_name="${tlName}"`);
  const query = buildQuery(tlName);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const jobId = response.data.jobReference.jobId;
  const location = response.data.jobReference.location;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(resultUrl);
  const rows = processResults(result);
  
  console.log(`    Rows found: ${rows.length}`);
  
  // Enrich rows with lookup data
  const enrichedRows = await Promise.all(rows.map(async (row) => {
    try {
      const lookupResults = await lookupProjectTask(
        row.staff_id, 
        row.project_name,
        row.task_name
      );
      
      // Add lookup data to the row
      return {
        ...row,
        lookup_data: lookupResults,
        has_lookup: lookupResults.length > 0
      };
    } catch (err) {
      console.warn(`Lookup failed for staff ${row.staff_id}:`, err.message);
      return {
        ...row,
        lookup_data: [],
        has_lookup: false,
        lookup_error: err.message
      };
    }
  }));
  
  return {
    tl_name: tlName,
    rows: enrichedRows,
    total_rows: enrichedRows.length,
    fetched_at: new Date().toISOString()
  };
}

// Install required package: npm install csv-parse

module.exports = {
  fetchProjectTaskLookup,
  getProjectTaskLookup,
  lookupProjectTask,
  getProjectsForStaff,
  getTasksForStaffProject,
  validateStaff,
  getStaffSummary,
  fetchSingleTLWithLookup
};
