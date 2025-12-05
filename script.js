// ===== Supabase Config =====
const SUPABASE_URL = "https://gzhfoeivkxsgihcjydja.supabase.co"; // TODO: ใส่ของจริง
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd6aGZvZWl2a3hzZ2loY2p5ZGphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MzU0MDAsImV4cCI6MjA4MDUxMTQwMH0.7PpAFpI9oMkaHkZZN8qyGUeUf-qmo_wEq6sPuM8xkCo";               // TODO: ใส่ของจริง

const supabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

// ===== Data Model (cache ในหน้าเว็บ) =====
let tasks = [];
let currentDetailMachineName = null;
let completePmTaskId = null;

// ===== Utilities =====

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) {
    d.setDate(0);
  }
  return d;
}

function stripTime(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDate(dateStr) {
  if (!dateStr) return "-";
  const d = new Date(dateStr);
  if (isNaN(d)) return "-";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ใช้ firstDueDate + lastDoneDate ในการหากำหนดครั้งถัดไป
function getTaskSchedule(task, today = new Date()) {
  const freq = Number(task.frequencyMonths) || 0;
  let nextDue;

  if (task.lastDoneDate) {
    nextDue = freq
      ? addMonths(new Date(task.lastDoneDate), freq)
      : new Date(task.lastDoneDate);
  } else if (task.firstDueDate) {
    nextDue = new Date(task.firstDueDate);
  } else {
    const base = task.createdAt ? new Date(task.createdAt) : today;
    nextDue = freq ? addMonths(base, freq) : base;
  }

  const reminderDate = addMonths(nextDue, -1);

  const todayStripped = stripTime(today);
  const nextStripped = stripTime(nextDue);

  let status = "normal";

  if (nextStripped < todayStripped) {
    status = "overdue";
  } else {
    const sameMonth =
      nextDue.getFullYear() === today.getFullYear() &&
      nextDue.getMonth() === today.getMonth();

    if (sameMonth) status = "thismonth";

    if (reminderDate <= today && nextStripped > todayStripped) {
      status = "reminder";
    }
  }

  return { nextDue, reminderDate, status };
}

// ===== Supabase I/O =====

// โหลดข้อมูลทั้งหมด
async function loadData() {
  const { data, error } = await supabase
    .from("pm_tasks")
    .select("*")
    .order("machine_name", { ascending: true })
    .order("first_due_date", { ascending: true });

  if (error) {
    console.error("โหลดข้อมูลจาก Supabase ไม่ได้", error);
    tasks = [];
    return;
  }

  tasks = data.map((row) => ({
    id: row.id,
    machineName: row.machine_name,
    taskName: row.task_name,
    frequencyMonths: row.frequency_months,
    firstDueDate: row.first_due_date,
    lastDoneDate: row.last_done_date,
    createdAt: row.created_at
      ? row.created_at.substring(0, 10)
      : row.first_due_date || new Date().toISOString().slice(0, 10),
  }));
}

async function createTaskOnSupabase(task) {
  const { data, error } = await supabase
    .from("pm_tasks")
    .insert({
      machine_name: task.machineName,
      task_name: task.taskName,
      frequency_months: task.frequencyMonths,
      first_due_date: task.firstDueDate,
      last_done_date: task.lastDoneDate,
    })
    .select()
    .single();

  if (error) {
    console.error("บันทึก PM ใหม่ไม่สำเร็จ", error);
    throw error;
  }

  return { ...task, id: data.id };
}

async function updateTaskOnSupabase(task) {
  const { error } = await supabase
    .from("pm_tasks")
    .update({
      machine_name: task.machineName,
      task_name: task.taskName,
      frequency_months: task.frequencyMonths,
      first_due_date: task.firstDueDate,
      last_done_date: task.lastDoneDate,
    })
    .eq("id", task.id);

  if (error) {
    console.error("อัปเดต PM ไม่สำเร็จ", error);
    throw error;
  }
}

async function deleteTaskOnSupabase(taskId) {
  const { error } = await supabase
    .from("pm_tasks")
    .delete()
    .eq("id", taskId);

  if (error) {
    console.error("ลบ PM ไม่สำเร็จ", error);
    throw error;
  }
}

// ทำ PM แล้ว + log ลง pm_logs
async function markTaskDoneOnSupabase(taskId, doneDate, detailText) {
  const { error: updateErr } = await supabase
    .from("pm_tasks")
    .update({ last_done_date: doneDate })
    .eq("id", taskId);

  if (updateErr) {
    console.error("อัปเดตวันที่ทำล่าสุดไม่สำเร็จ", updateErr);
    throw updateErr;
  }

  const { error: logErr } = await supabase.from("pm_logs").insert({
    task_id: taskId,
    done_at: doneDate,
    detail: detailText || null,
  });

  if (logErr) {
    console.error("บันทึก log PM ไม่สำเร็จ", logErr);
    throw logErr;
  }
}

// ===== Rendering =====

function renderToday() {
  const el = document.getElementById("todayText");
  const d = new Date();
  const dateStr = d.toLocaleDateString("th-TH", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const timeStr = d.toLocaleTimeString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
  });
  el.textContent = `${dateStr} ${timeStr}`;
}

function getDistinctMachines() {
  const set = new Set(tasks.map((t) => t.machineName.trim()).filter(Boolean));
  return Array.from(set);
}

function renderMachineDatalist() {
  const datalist = document.getElementById("machineList");
  datalist.innerHTML = "";
  getDistinctMachines().forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m;
    datalist.appendChild(opt);
  });
}

function renderStats() {
  document.getElementById("statMachines").textContent =
    getDistinctMachines().length;
  document.getElementById("statTasks").textContent = tasks.length;

  let overdue = 0,
    thisMonth = 0,
    reminder = 0;
  const today = new Date();

  tasks.forEach((t) => {
    const { status } = getTaskSchedule(t, today);
    if (status === "overdue") overdue++;
    if (status === "thismonth") thisMonth++;
    if (status === "reminder") reminder++;
  });

  document.getElementById("statOverdue").textContent = overdue;
  document.getElementById("statThisMonth").textContent = thisMonth;
  document.getElementById("statReminder").textContent = reminder;
}

function createStatusBadge(status) {
  const span = document.createElement("span");
  span.classList.add("status-badge");
  switch (status) {
    case "overdue":
      span.classList.add("status-overdue");
      span.textContent = "Overdue";
      break;
    case "thismonth":
      span.classList.add("status-thismonth");
      span.textContent = "กำหนดเดือนนี้";
      break;
    case "reminder":
      span.classList.add("status-reminder");
      span.textContent = "เตือนล่วงหน้า";
      break;
    default:
      span.classList.add("status-normal");
      span.textContent = "ปกติ";
  }
  return span;
}

// Dashboard grouped by machine
function renderDashboardTable() {
  const container = document.getElementById("dashboardMachineContainer");
  container.innerHTML = "";

  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.textContent = "ยังไม่มีรายการ PM ในระบบ";
    empty.style.textAlign = "center";
    empty.style.color = "#9ca3af";
    container.appendChild(empty);
    return;
  }

  const today = new Date();
  const enriched = tasks.map((t) => ({ ...t, ...getTaskSchedule(t, today) }));

  const groups = {};
  enriched.forEach((t) => {
    const key = t.machineName || "ไม่ระบุเครื่อง";
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  const machineNames = Object.keys(groups).sort((a, b) =>
    a.localeCompare(b, "th-TH")
  );

  machineNames.forEach((machineName) => {
    const machineTasks = groups[machineName].sort(
      (a, b) => a.nextDue - b.nextDue
    );

    const total = machineTasks.length;
    const overdueCount = machineTasks.filter((t) => t.status === "overdue")
      .length;
    const thisMonthCount = machineTasks.filter(
      (t) => t.status === "thismonth"
    ).length;
    const reminderCount = machineTasks.filter(
      (t) => t.status === "reminder"
    ).length;

    const card = document.createElement("div");
    card.className = "machine-card";

    const header = document.createElement("div");
    header.className = "machine-card-header";

    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "machine-card-title";
    title.textContent = machineName;

    const subtitle = document.createElement("div");
    subtitle.className = "machine-card-subtitle";
    subtitle.textContent = `PM ${total} รายการ • Overdue ${overdueCount} • เดือนนี้ ${thisMonthCount} • เตือนล่วงหน้า ${reminderCount}`;

    left.appendChild(title);
    left.appendChild(subtitle);
    header.appendChild(left);
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "machine-card-body";

    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML = `
      <tr>
        <th>รายการ PM</th>
        <th>รอบ (เดือน)</th>
        <th>ทำล่าสุด</th>
        <th>กำหนดครั้งถัดไป</th>
        <th>สถานะ</th>
      </tr>`;
    const tbody = document.createElement("tbody");

    machineTasks.forEach((t) => {
      const tr = document.createElement("tr");

      const tdTask = document.createElement("td");
      tdTask.textContent = t.taskName;
      tr.appendChild(tdTask);

      const tdFreq = document.createElement("td");
      tdFreq.textContent = t.frequencyMonths;
      tr.appendChild(tdFreq);

      const tdLast = document.createElement("td");
      tdLast.textContent = t.lastDoneDate
        ? formatDate(t.lastDoneDate)
        : "ยังไม่เคยทำ";
      tr.appendChild(tdLast);

      const tdNext = document.createElement("td");
      tdNext.textContent = formatDate(
        t.nextDue.toISOString().slice(0, 10)
      );
      tr.appendChild(tdNext);

      const tdStatus = document.createElement("td");
      tdStatus.appendChild(createStatusBadge(t.status));
      tr.appendChild(tdStatus);

      tbody.appendChild(tr);
    });

    table.appendChild(thead);
    table.appendChild(tbody);
    wrapper.appendChild(table);
    body.appendChild(wrapper);
    card.appendChild(body);
    container.appendChild(card);
  });
}

// Filter dropdown options
function renderTaskMachineFilter() {
  const select = document.getElementById("taskMachineFilter");
  if (!select) return;
  const current = select.value || "all";
  select.innerHTML = '<option value="all">ทุกเครื่อง</option>';
  getDistinctMachines().forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    select.appendChild(opt);
  });
  const has = Array.from(select.options).some((o) => o.value === current);
  select.value = has ? current : "all";
}

// ตารางรายการ PM
function renderTaskTable() {
  const tbody = document.getElementById("taskTableBody");
  tbody.innerHTML = "";

  if (!tasks.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.textContent = "ยังไม่มีรายการ PM กรุณาเพิ่มจากปุ่ม “สร้างรายการ PM”";
    td.style.textAlign = "center";
    td.style.color = "#9ca3af";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const today = new Date();
  const filterSelect = document.getElementById("taskMachineFilter");
  const filterValue = filterSelect ? filterSelect.value : "all";

  const enriched = tasks
    .map((t) => ({ ...t, ...getTaskSchedule(t, today) }))
    .sort((a, b) => {
      if (a.machineName === b.machineName) {
        return a.nextDue - b.nextDue;
      }
      return a.machineName.localeCompare(b.machineName, "th-TH");
    })
    .filter(
      (t) => filterValue === "all" || t.machineName === filterValue
    );

  enriched.forEach((t) => {
    const tr = document.createElement("tr");

    const tdM = document.createElement("td");
    tdM.textContent = t.machineName;
    tr.appendChild(tdM);

    const tdTask = document.createElement("td");
    tdTask.textContent = t.taskName;
    tr.appendChild(tdTask);

    const tdFreq = document.createElement("td");
    tdFreq.textContent = t.frequencyMonths;
    tr.appendChild(tdFreq);

    const tdLast = document.createElement("td");
    tdLast.textContent = t.lastDoneDate
      ? formatDate(t.lastDoneDate)
      : "ยังไม่เคยทำ";
    tr.appendChild(tdLast);

    const tdNext = document.createElement("td");
    tdNext.textContent = formatDate(
      t.nextDue.toISOString().slice(0, 10)
    );
    tr.appendChild(tdNext);

    const tdStatus = document.createElement("td");
    tdStatus.appendChild(createStatusBadge(t.status));
    tr.appendChild(tdStatus);

    const tdActions = document.createElement("td");
    const doneBtn = document.createElement("button");
    doneBtn.className = "chip-btn";
    doneBtn.textContent = "ทำ PM แล้ว";
    doneBtn.addEventListener("click", () => openCompletePmModal(t));
    tdActions.appendChild(doneBtn);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });

  if (!tbody.children.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.style.textAlign = "center";
    td.style.color = "#9ca3af";
    td.textContent = "ไม่พบรายการ PM สำหรับเครื่องที่เลือก";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

// ตารางเครื่องจักร
function renderMachineTable() {
  const tbody = document.getElementById("machineTableBody");
  tbody.innerHTML = "";

  const machines = getDistinctMachines();

  if (!machines.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 2;
    td.textContent =
      "ยังไม่มีเครื่องในระบบ (ระบบจะสร้างจากชื่อเครื่องที่กรอกในฟอร์ม PM)";
    td.style.textAlign = "center";
    td.style.color = "#9ca3af";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  machines.forEach((m) => {
    const tr = document.createElement("tr");
    tr.className = "clickable-row";
    tr.addEventListener("click", () => openMachineDetailModal(m));

    const tdName = document.createElement("td");
    tdName.textContent = m;

    const tdCount = document.createElement("td");
    const count = tasks.filter((t) => t.machineName === m).length;
    tdCount.textContent = `${count} รายการ PM`;

    tr.appendChild(tdName);
    tr.appendChild(tdCount);
    tbody.appendChild(tr);
  });
}

// เปอร์เซ็นต์ทำตามแผนในเดือนนี้
function renderMonthlyPlanStats() {
  const overallPercentEl = document.getElementById("monthlyOverallPercent");
  const overallDetailEl = document.getElementById("monthlyOverallDetail");
  const tbody = document.getElementById("monthlyMachineTableBody");

  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();

  const dueThisMonth = tasks.filter((t) => {
    const freq = Number(t.frequencyMonths) || 0;
    if (!freq || !t.firstDueDate) return false;

    const first = new Date(t.firstDueDate);
    if (isNaN(first)) return false;

    const diffMonths =
      (year - first.getFullYear()) * 12 + (month - first.getMonth());
    if (diffMonths < 0) return false;

    return diffMonths % freq === 0;
  });

  const totalDue = dueThisMonth.length;

  const isDoneThisMonth = (t) => {
    if (!t.lastDoneDate) return false;
    const d = new Date(t.lastDoneDate);
    return d.getFullYear() === year && d.getMonth() === month;
  };

  const doneThisMonth = dueThisMonth.filter(isDoneThisMonth);
  const doneCount = doneThisMonth.length;

  if (totalDue === 0) {
    overallPercentEl.textContent = "-";
    overallDetailEl.textContent = "ยังไม่มีงาน PM ตามแผนในเดือนนี้";
  } else {
    const percent = Math.round((doneCount / totalDue) * 100);
    overallPercentEl.textContent = `${percent}%`;
    overallDetailEl.textContent = `${doneCount} / ${totalDue} งานตามแผนเดือนนี้ทำแล้ว`;
  }

  tbody.innerHTML = "";

  if (totalDue === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.style.textAlign = "center";
    td.style.color = "#9ca3af";
    td.textContent = "ยังไม่มีงาน PM ตามแผนในเดือนนี้";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const machines = getDistinctMachines().sort((a, b) =>
    a.localeCompare(b, "th-TH")
  );

  machines.forEach((m) => {
    const dueForMachine = dueThisMonth.filter((t) => t.machineName === m);
    if (!dueForMachine.length) return;

    const doneForMachine = dueForMachine.filter(isDoneThisMonth);
    const dueCount = dueForMachine.length;
    const doneCountM = doneForMachine.length;
    const percentM = Math.round((doneCountM / dueCount) * 100);

    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = m;

    const tdDue = document.createElement("td");
    tdDue.textContent = dueCount;

    const tdDone = document.createElement("td");
    tdDone.textContent = doneCountM;

    const tdPercent = document.createElement("td");
    tdPercent.textContent = `${percentM}%`;

    tr.appendChild(tdName);
    tr.appendChild(tdDue);
    tr.appendChild(tdDone);
    tr.appendChild(tdPercent);
    tbody.appendChild(tr);
  });

  if (!tbody.children.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.style.textAlign = "center";
    td.style.color = "#9ca3af";
    td.textContent = "ยังไม่มีงาน PM ตามแผนในเดือนนี้";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

// ===== Actions =====

// สร้าง / เพิ่ม task ใหม่
async function handleTaskFormSubmit(event) {
  event.preventDefault();

  const machineNameInput = document.getElementById("machineName");
  const taskNameInput = document.getElementById("taskName");
  const freqSelect = document.getElementById("frequencyMonths");
  const firstDueInput = document.getElementById("firstDueDate");
  const lastDoneInput = document.getElementById("lastDoneDate");

  const machineName = machineNameInput.value.trim();
  const taskName = taskNameInput.value.trim();
  const frequencyMonths = Number(freqSelect.value);
  const todayIso = new Date().toISOString().slice(0, 10);

  if (!machineName || !taskName || !frequencyMonths) return;

  const firstDueDate = firstDueInput.value || todayIso;
  const lastDoneDate = lastDoneInput.value || null;

  const newTask = {
    machineName,
    taskName,
    frequencyMonths,
    firstDueDate,
    lastDoneDate,
    createdAt: todayIso,
  };

  try {
    const savedTask = await createTaskOnSupabase(newTask);
    tasks.push(savedTask);

    taskNameInput.value = "";
    lastDoneInput.value = "";

    // ซ่อนฟอร์ม กลับไปหน้าตาราง
    document.getElementById("taskFormPanel").classList.add("hidden");
    document.getElementById("taskListPanel").classList.remove("hidden");

    refreshUI();
  } catch (err) {
    console.error(err);
    alert("บันทึก PM ใหม่ไม่สำเร็จ กรุณาลองอีกครั้ง");
  }
}

// ลบ task
async function deleteTask(taskId) {
  const ok = confirm("ต้องการลบรายการ PM นี้หรือไม่?");
  if (!ok) return;

  try {
    await deleteTaskOnSupabase(taskId);
    tasks = tasks.filter((t) => t.id !== taskId);
    refreshUI();

    if (currentDetailMachineName) {
      const stillHas = tasks.some(
        (t) => t.machineName === currentDetailMachineName
      );
      if (stillHas) {
        openMachineDetailModal(currentDetailMachineName);
      } else {
        closeMachineDetailModal();
      }
    }
  } catch (err) {
    console.error(err);
    alert("ลบ PM ไม่สำเร็จ");
  }
}

// ===== MODAL: Machine detail =====

function openMachineDetailModal(machineName) {
  currentDetailMachineName = machineName;

  const modalBackdrop = document.getElementById("machineDetailModal");
  const titleEl = document.getElementById("modalMachineTitle");
  const subtitleEl = document.getElementById("modalMachineSubtitle");
  const tbody = document.getElementById("modalTaskTableBody");

  titleEl.textContent = `รายละเอียดแผน PM : ${machineName}`;

  const today = new Date();
  const machineTasks = tasks
    .filter((t) => t.machineName === machineName)
    .map((t) => ({ ...t, ...getTaskSchedule(t, today) }))
    .sort((a, b) => a.nextDue - b.nextDue);

  const total = machineTasks.length;
  const overdueCount = machineTasks.filter((t) => t.status === "overdue").length;
  const thisMonthCount = machineTasks.filter((t) => t.status === "thismonth").length;
  const reminderCount = machineTasks.filter((t) => t.status === "reminder").length;

  subtitleEl.textContent = `PM ${total} รายการ • Overdue ${overdueCount} • เดือนนี้ ${thisMonthCount} • เตือนล่วงหน้า ${reminderCount}`;

  tbody.innerHTML = "";

  if (!machineTasks.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.textContent = "ยังไม่มีรายการ PM สำหรับเครื่องนี้";
    td.style.textAlign = "center";
    td.style.color = "#9ca3af";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    machineTasks.forEach((t) => {
      const tr = document.createElement("tr");

      const tdTask = document.createElement("td");
      tdTask.textContent = t.taskName;
      tr.appendChild(tdTask);

      const tdFreq = document.createElement("td");
      tdFreq.textContent = t.frequencyMonths;
      tr.appendChild(tdFreq);

      const tdFirst = document.createElement("td");
      tdFirst.textContent = formatDate(t.firstDueDate);
      tr.appendChild(tdFirst);

      const tdLast = document.createElement("td");
      tdLast.textContent = t.lastDoneDate
        ? formatDate(t.lastDoneDate)
        : "ยังไม่เคยทำ";
      tr.appendChild(tdLast);

      const tdNext = document.createElement("td");
      tdNext.textContent = formatDate(t.nextDue.toISOString().slice(0, 10));
      tr.appendChild(tdNext);

      const tdStatus = document.createElement("td");
      tdStatus.appendChild(createStatusBadge(t.status));
      tr.appendChild(tdStatus);

      const tdActions = document.createElement("td");

      const editBtn = document.createElement("button");
      editBtn.className = "chip-btn";
      editBtn.textContent = "แก้ไข";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        startEditTaskFromModal(t.id);
      });

      const delBtn = document.createElement("button");
      delBtn.className = "chip-btn";
      delBtn.textContent = "ลบ";
      delBtn.style.marginLeft = "4px";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteTask(t.id);
      });

      tdActions.appendChild(editBtn);
      tdActions.appendChild(delBtn);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    });
  }

  // ✅ ทุกครั้งที่เปิด modal ให้ซ่อนฟอร์มแก้ไขก่อน
  clearModalEditForm();
  hideModalEditPanel();

  modalBackdrop.classList.remove("hidden");
}


function closeMachineDetailModal() {
  document.getElementById("machineDetailModal").classList.add("hidden");
  currentDetailMachineName = null;
  clearModalEditForm();
}

function startEditTaskFromModal(taskId) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;

  // ✅ โชว์ฟอร์มแก้ไขเฉพาะตอนกดปุ่ม
  showModalEditPanel();

  document.getElementById("modalTaskId").value = task.id;
  document.getElementById("modalEditMachineName").value = task.machineName;
  document.getElementById("modalEditTaskName").value = task.taskName;
  document.getElementById("modalEditFrequency").value =
    task.frequencyMonths || 1;
  document.getElementById("modalEditFirstDue").value =
    task.firstDueDate || "";
  document.getElementById("modalEditLastDone").value =
    task.lastDoneDate || "";
}


function clearModalEditForm() {
  document.getElementById("modalTaskId").value = "";
  document.getElementById("modalEditMachineName").value = "";
  document.getElementById("modalEditTaskName").value = "";
  document.getElementById("modalEditFrequency").value = "6";
  document.getElementById("modalEditFirstDue").value = "";
  document.getElementById("modalEditLastDone").value = "";

  // ✅ เคลียร์แล้วให้ซ่อนฟอร์ม
  hideModalEditPanel();
}


// submit แก้ไขจาก modal
async function handleModalEditFormSubmit(event) {
  event.preventDefault();
  const id = document.getElementById("modalTaskId").value;
  if (!id) return;

  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return;

  const machineName = document
    .getElementById("modalEditMachineName")
    .value.trim();
  const taskName = document
    .getElementById("modalEditTaskName")
    .value.trim();
  const frequencyMonths = Number(
    document.getElementById("modalEditFrequency").value
  );
  const firstDueDate = document.getElementById("modalEditFirstDue").value;
  const lastDoneDate =
    document.getElementById("modalEditLastDone").value || null;

  if (!machineName || !taskName || !frequencyMonths || !firstDueDate) {
    return;
  }

  const updated = {
    ...tasks[idx],
    machineName,
    taskName,
    frequencyMonths,
    firstDueDate,
    lastDoneDate,
  };

  try {
    await updateTaskOnSupabase(updated);
    tasks[idx] = updated;
    refreshUI();
    currentDetailMachineName = machineName;
    openMachineDetailModal(machineName);
  } catch (err) {
    console.error(err);
    alert("บันทึกการแก้ไขไม่สำเร็จ");
  }
}

function showModalEditPanel() {
  const panel = document.getElementById("modalEditPanel");
  if (panel) panel.classList.remove("hidden");
}

function hideModalEditPanel() {
  const panel = document.getElementById("modalEditPanel");
  if (panel) panel.classList.add("hidden");
}

// ===== MODAL: Complete PM =====

function openCompletePmModal(task) {
  completePmTaskId = task.id;
  document.getElementById("completePmTaskId").value = task.id;
  document.getElementById(
    "completePmTaskInfo"
  ).textContent = `${task.machineName} • ${task.taskName}`;
  document.getElementById("completePmDate").value =
    new Date().toISOString().slice(0, 10);
  document.getElementById("completePmDetail").value = "";
  document.getElementById("completePmModal").classList.remove("hidden");
}

function closeCompletePmModal() {
  document.getElementById("completePmModal").classList.add("hidden");
  completePmTaskId = null;
}

async function handleCompletePmFormSubmit(event) {
  event.preventDefault();
  const id = document.getElementById("completePmTaskId").value;
  const doneDate = document.getElementById("completePmDate").value;
  const detail = document
    .getElementById("completePmDetail")
    .value.trim();

  if (!id || !doneDate) return;

  try {
    await markTaskDoneOnSupabase(id, doneDate, detail);
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx !== -1) tasks[idx].lastDoneDate = doneDate;
    refreshUI();
    if (currentDetailMachineName) {
      openMachineDetailModal(currentDetailMachineName);
    }
    closeCompletePmModal();
  } catch (err) {
    console.error(err);
    alert("บันทึกการทำ PM ไม่สำเร็จ");
  }
}

// ===== Navigation & Setup =====

function setupNavigation() {
  const buttons = document.querySelectorAll(".nav-btn");
  const sections = document.querySelectorAll(".view-section");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");

      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      sections.forEach((sec) => {
        sec.classList.toggle("active", sec.id === targetId);
      });
    });
  });
}

function setupResetButton() {
  const btn = document.getElementById("resetDataBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const ok = confirm(
      "ต้องการลบข้อมูลทั้งหมดใน Supabase หรือไม่? (ลบจริง ย้อนกลับไม่ได้)"
    );
    if (!ok) return;

    const { error } = await supabase
      .from("pm_tasks")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");

    if (error) {
      console.error(error);
      alert("ล้างข้อมูลไม่สำเร็จ");
      return;
    }

    tasks = [];
    refreshUI();
  });
}

function setupModalEvents() {
  const modalBackdrop = document.getElementById("machineDetailModal");
  const closeBtn = document.getElementById("modalCloseBtn");
  const cancelEditBtn = document.getElementById("modalCancelEditBtn");
  const editForm = document.getElementById("modalEditForm");

  closeBtn.addEventListener("click", closeMachineDetailModal);
  cancelEditBtn.addEventListener("click", clearModalEditForm);

  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closeMachineDetailModal();
  });

  editForm.addEventListener("submit", handleModalEditFormSubmit);
}

function setupCompletePmModalEvents() {
  const modalBackdrop = document.getElementById("completePmModal");
  const closeBtn = document.getElementById("completePmCloseBtn");
  const cancelBtn = document.getElementById("completePmCancelBtn");
  const form = document.getElementById("completePmForm");

  closeBtn.addEventListener("click", closeCompletePmModal);
  cancelBtn.addEventListener("click", closeCompletePmModal);

  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closeCompletePmModal();
  });

  form.addEventListener("submit", handleCompletePmFormSubmit);
}

function setupTaskViewControls() {
  const showBtn = document.getElementById("showCreateFormBtn");
  const formPanel = document.getElementById("taskFormPanel");
  const listPanel = document.getElementById("taskListPanel");
  const cancelBtn = document.getElementById("taskFormCancelBtn");
  const filterSelect = document.getElementById("taskMachineFilter");

  showBtn.addEventListener("click", () => {
    formPanel.classList.remove("hidden");
    listPanel.classList.add("hidden");
  });

  cancelBtn.addEventListener("click", () => {
    formPanel.classList.add("hidden");
    listPanel.classList.remove("hidden");
  });

  filterSelect.addEventListener("change", () => renderTaskTable());
}

// รวมรีเฟรช UI ทั้งหมด
function refreshUI() {
  renderToday();
  renderStats();
  renderMonthlyPlanStats();
  renderDashboardTable();
  renderTaskMachineFilter();
  renderTaskTable();
  renderMachineTable();
  renderMachineDatalist();
}

// Init
async function initApp() {
  setupNavigation();
  setupResetButton();
  setupModalEvents();
  setupCompletePmModalEvents();
  setupTaskViewControls();

  document
    .getElementById("taskForm")
    .addEventListener("submit", handleTaskFormSubmit);

  await loadData();
  refreshUI();
}

document.addEventListener("DOMContentLoaded", () => {
  initApp().catch((err) => console.error("initApp error", err));
});
