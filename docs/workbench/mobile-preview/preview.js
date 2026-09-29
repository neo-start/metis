// Self-contained interaction proposal. No API, account, network or filesystem access.
const tasks = [
  {
    title: "修复移动端输入框",
    project: "Metis",
    agent: "Codex",
    state: "pending",
    time: "刚刚",
  },
  {
    title: "整理移动端交互参考",
    project: "产品调研",
    agent: "Claude Code",
    state: "running",
    time: "3 分钟前",
  },
  {
    title: "准备产品更新说明",
    project: "Metis",
    agent: "Claude Code",
    state: "completed",
    time: "20 分钟前",
  },
  {
    title: "检查工作台导航",
    project: "Metis",
    agent: "Codex",
    state: "completed",
    time: "昨天",
  },
];
const files = {
  changes: {
    title: "输入框布局修改",
    name: "mobile-composer.demo.patch",
    content:
      "# 示例修改，非真实项目 diff\n\n- 输入区域使用固定窗口高度\n+ 输入区域跟随可视高度变化\n+ 保留底部安全区\n+ 键盘关闭时恢复原滚动位置\n",
  },
  notes: {
    title: "手机体验调研",
    name: "research.demo.md",
    content:
      "# 手机体验调研\n\n这是一份用于展示排版的示例文档。\n\n## 在外面继续工作\n\n手机最常见的动作：查看进度、补充指令、确认下一步。\n\n- 等待处理的事项优先显示。\n- 文件保留对应任务和生成来源。\n- 断线时明确显示离线，不自动重发指令。\n\n## 下一步\n\n验证电脑启动任务，手机处理授权，两端状态一致。\n",
  },
  release: {
    title: "本周更新说明",
    name: "release-notes.demo.md",
    content:
      "# 更新说明草案\n\n示例内容，不代表已实现功能。\n\n- 手机查看电脑上的任务进度。\n- 在对话中处理待确认操作。\n- 集中查看任务成果。\n\n远程连接和原生手机端尚待实现。\n",
  },
};
let online = true;
let authorized = true;
let filter = "all";
let activeFile = "notes";
let toastTimer;
const icon = (name) => `<svg aria-hidden="true"><use href="#${name}"/></svg>`;
const escape = (value) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
function notify(message) {
  const node = document.querySelector("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3400);
}
function selectScreen(name) {
  document
    .querySelectorAll(".screen-column")
    .forEach((el) => el.classList.toggle("selected", el.id === `screen-${name}`));
  document.querySelectorAll(".screen-picker [data-screen]").forEach((el) => {
    const active = el.dataset.screen === name;
    el.classList.toggle("selected", active);
    el.setAttribute("aria-pressed", String(active));
  });
  const header = document.querySelector(`#screen-${name} .screen-caption h2`);
  header.tabIndex = -1;
  header.focus({ preventScroll: true });
  if (matchMedia("(max-width:760px)").matches)
    document.querySelector(".screen-picker").scrollIntoView({ block: "start" });
}
function renderTasks() {
  const visible = tasks.filter((task) => filter === "all" || task.state === filter);
  const labels = {
    pending: "等待确认",
    running: "正在执行",
    completed: "已完成",
    stopped: "已停止",
    rejected: "已拒绝操作",
  };
  const icons = {
    pending: "alert",
    running: "clock",
    completed: "check",
    stopped: "square",
    rejected: "x",
  };
  document.querySelector("#task-list").innerHTML = visible.length
    ? visible
        .map((task) => {
          const index = tasks.indexOf(task);
          return `<button class="task-row" data-task="${index}"><strong>${escape(task.title)}</strong><span class="task-project">${escape(task.project)} · ${escape(task.agent)}</span><span class="task-metadata"><span class="task-status ${task.state}">${icon(icons[task.state])}${labels[task.state]}</span><span>${task.time}</span></span></button>`;
        })
        .join("")
    : '<p class="empty-filter">这个状态下暂时没有示例任务。</p>';
  document.querySelector("#task-count").textContent = `${tasks.length} 项`;
}
function updateConnection() {
  const usable = online && authorized;
  document.body.classList.toggle("offline", !usable);
  document
    .querySelectorAll(".host-state")
    .forEach(
      (el) =>
        (el.textContent = !authorized
          ? "授权已撤销 · 需要重新配对"
          : online
            ? "已连接 · 可继续任务"
            : "电脑离线 · 显示上次记录"),
    );
  document.querySelector(".connection-copy").textContent = !authorized
    ? "设备授权已撤销"
    : online
      ? "正在连接的电脑上执行"
      : "电脑暂时离线 · 等待重新连接";
  document.querySelectorAll(".remote-action").forEach((el) => (el.disabled = !usable));
  document.querySelector("#message-input").disabled = !usable;
  document.querySelector("#composer-hint").textContent = usable
    ? "示例对话 · 不会发送给真实 Agent"
    : "发送已暂停，恢复连接后由你重新发送";
  document.querySelector("#network-toggle").innerHTML =
    `${icon(online ? "wifi-off" : "refresh")}${online ? "模拟电脑离线" : "恢复示例连接"}`;
}
function appendUpdate(message, className = "result-line") {
  const el = document.createElement("p");
  el.className = className;
  el.textContent = message;
  el.tabIndex = -1;
  document.querySelector("#conversation-updates").append(el);
  const scroller = document.querySelector("#conversation-scroll");
  scroller.scrollTop = scroller.scrollHeight;
  return el;
}
function decideApproval(allow) {
  if (!online || !authorized || tasks[0].state !== "pending") return;
  tasks[0].state = allow ? "running" : "rejected";
  document.querySelector("#approval-box").hidden = true;
  document.querySelector("#attention-title").textContent = allow
    ? "任务继续执行中"
    : "这次操作已拒绝";
  document.querySelector("#attention-subtitle").textContent = allow
    ? "允许本次检查，其他操作仍会单独询问"
    : "可以在对话中补充新的要求";
  const result = appendUpdate(
    allow
      ? "已允许本次检查。示例任务切换为执行中；这里不会真正运行命令。"
      : "已拒绝本次检查。示例会话保留，等待你的后续说明。",
  );
  result.focus({ preventScroll: true });
  renderTasks();
  notify(allow ? "示例：已允许本次操作" : "示例：已拒绝本次操作");
}
function openFile(key) {
  activeFile = key;
  const file = files[key];
  document.querySelector("#file-title").textContent = file.title;
  document.querySelector("#file-subtitle").textContent = `${file.name} · 保存在本演示中的示例文本`;
  document.querySelector("#file-content").textContent = file.content;
  document.querySelector("#file-dialog").showModal();
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.hasAttribute("data-close")) {
    button.closest("dialog").close();
    return;
  }
  if (button.dataset.screen) selectScreen(button.dataset.screen);
  if (button.dataset.filter) {
    filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((el) => {
      el.classList.toggle("selected", el.dataset.filter === filter);
      el.setAttribute("aria-pressed", String(el.dataset.filter === filter));
    });
    renderTasks();
  }
  if (button.dataset.file) openFile(button.dataset.file);
  if (button.dataset.task !== undefined) {
    if (Number(button.dataset.task) === 0) selectScreen("conversation");
    else
      notify(
        `示例任务「${tasks[Number(button.dataset.task)].title}」；本稿完整演示第一条任务的对话。`,
      );
  }
  switch (button.dataset.action) {
    case "devices":
      document.querySelector("#device-dialog").showModal();
      break;
    case "new-task":
      if (!online || !authorized) notify("恢复连接和授权后可新建示例任务");
      else document.querySelector("#new-task-dialog").showModal();
      break;
    case "approval":
      selectScreen("conversation");
      document.querySelector("#approval-box").scrollIntoView({ block: "nearest" });
      break;
    case "approve":
      decideApproval(true);
      break;
    case "deny":
      decideApproval(false);
      break;
    case "stop":
      if (!online || !authorized) notify("离线时无法发送停止指令");
      else if (["stopped", "rejected"].includes(tasks[0].state)) notify("示例任务当前未执行");
      else document.querySelector("#stop-dialog").showModal();
      break;
  }
});
document.querySelector("#network-toggle").addEventListener("click", () => {
  online = !online;
  updateConnection();
  notify(online ? "示例连接已恢复，没有自动重发指令" : "模拟电脑离线：保留记录，暂停远程操作");
});
document.querySelector("#reset").addEventListener("click", () => location.reload());
document.querySelector("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#message-input");
  const message = input.value.trim();
  if (!message || !online || !authorized) return;
  appendUpdate(message, "user-bubble");
  appendUpdate("示例消息已加入本页。真实版本会提交给这台电脑上的同一段会话。");
  input.value = "";
});
document.querySelector("#new-task-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#task-title");
  if (!input.value.trim() || !online || !authorized) return;
  tasks.push({
    title: input.value.trim(),
    project: "Metis",
    agent: "Codex",
    state: "running",
    time: "刚刚",
  });
  filter = "all";
  document.querySelector('[data-filter="all"]').click();
  document.querySelector("#new-task-dialog").close();
  input.value = "";
  renderTasks();
  selectScreen("tasks");
  notify("已添加示例任务，不会启动 Agent");
});
document.querySelector("#confirm-stop").addEventListener("click", () => {
  if (!online || !authorized) return;
  tasks[0].state = "stopped";
  document.querySelector("#stop-dialog").close();
  document.querySelector("#approval-box").hidden = true;
  document.querySelector("#attention-title").textContent = "任务已停止";
  document.querySelector("#attention-subtitle").textContent = "已有对话和成果仍保留";
  appendUpdate("示例执行已停止。已有记录保留。");
  renderTasks();
});
document.querySelector("#revoke-device").addEventListener("click", () => {
  authorized = !authorized;
  document.querySelector("#phone-authorization").textContent = authorized
    ? "演示设备 · 已授权"
    : "演示设备 · 授权已撤销";
  document.querySelector("#revoke-device").textContent = authorized ? "撤销" : "恢复演示授权";
  updateConnection();
});
document.querySelector("#pair-device").addEventListener("click", () => {
  document.querySelector("#pairing-description").hidden = false;
});
document.querySelector("#confirm-pairing").addEventListener("click", () => {
  document.querySelector("#pairing-description").hidden = true;
  const row = document.createElement("div");
  row.className = "device-row";
  row.innerHTML = `${icon("laptop")}<div><strong>另一台 Mac · 示例</strong><p>模拟配对完成，尚无真实连接</p></div>`;
  row.tabIndex = -1;
  document.querySelector("#pair-device").before(row);
  row.focus();
  document.querySelector("#pair-device").disabled = true;
});
document.querySelector("#download-file").addEventListener("click", () => {
  const file = files[activeFile];
  const url = URL.createObjectURL(new Blob([file.content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
renderTasks();
updateConnection();
