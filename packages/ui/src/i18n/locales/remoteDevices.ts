export const remoteDevicesZhCN = {
  "project.source.local": "本地",
  "project.source.remote": "远程",
  "project.source.mixed": "本地 + 远程",
  "project.open.deviceUnavailable": "项目的远程设备未连接或配置已更改，请检查远程设备后重试。",
  "project.open.changed": "连接期间项目或设备配置已更改，请重新打开项目。",
  "remote.connectionBackground": "在后台继续",
  "settings.remoteDevices.title": "远程设备",
  "settings.remoteDevices.description":
    "管理 SSH 主机、WSL 发行版和 Docker 容器。连接状态与当前窗口同步。",
  "settings.remoteDevices.new": "新建连接",
  "settings.remoteDevices.search": "搜索设备或项目路径",
  "settings.remoteDevices.count": "设备 {count}",
  "settings.remoteDevices.connected": "已连接",
  "settings.remoteDevices.connecting": "连接中",
  "settings.remoteDevices.offline": "未连接",
  "settings.remoteDevices.failed": "连接失败",
  "settings.remoteDevices.reconnect": "连接",
  "settings.remoteDevices.disconnect": "断开",
  "settings.remoteDevices.configure": "修改连接",
  "settings.remoteDevices.openFolder": "打开目录",
  "settings.remoteDevices.remove": "移除设备",
  "settings.remoteDevices.projects": "{count} 个项目",
  "settings.remoteDevices.logs": "最近连接日志 · {count} 条",
  "settings.remoteDevices.noLogs": "暂无本次连接日志。下次重连时会显示真实连接进展。",
  "settings.remoteDevices.empty": "还没有远程设备。新建连接即可保存，无需选择项目目录。",
  "settings.remoteDevices.noMatches": "没有匹配的设备或项目。",
  "settings.remoteDevices.duplicate": "此设备已存在，请从设备列表修改或连接。",
  "settings.remoteDevices.manualReconnect": "应用启动后保留设备与项目记录，连接由你手动发起。",
  "settings.remoteDevices.disconnectTitle": "断开这台设备？",
  "settings.remoteDevices.disconnectDescription":
    "将断开本窗口中该设备的 {count} 个项目连接，并取消在途重连。远端任务文件和设备记录会保留。",
  "settings.remoteDevices.removeTitle": "移除这台设备的记录？",
  "settings.remoteDevices.removeDescription":
    "移除连接配置，保留项目、文件及正在运行的任务。之后可重新添加设备。",
};

export const remoteDevicesEnUS: Record<keyof typeof remoteDevicesZhCN, string> = {
  "project.source.local": "Local",
  "project.source.remote": "Remote",
  "project.source.mixed": "Local + remote",
  "project.open.deviceUnavailable":
    "The project's remote device is unavailable or its configuration changed. Check Remote devices and retry.",
  "project.open.changed": "The project or device changed while connecting. Open the project again.",
  "remote.connectionBackground": "Continue in background",
  "settings.remoteDevices.title": "Remote devices",
  "settings.remoteDevices.description":
    "Manage SSH hosts, WSL distributions and Docker containers. Connection status follows this window.",
  "settings.remoteDevices.new": "New connection",
  "settings.remoteDevices.search": "Search devices or project paths",
  "settings.remoteDevices.count": "Devices {count}",
  "settings.remoteDevices.connected": "Connected",
  "settings.remoteDevices.connecting": "Connecting",
  "settings.remoteDevices.offline": "Not connected",
  "settings.remoteDevices.failed": "Connection failed",
  "settings.remoteDevices.reconnect": "Connect",
  "settings.remoteDevices.disconnect": "Disconnect",
  "settings.remoteDevices.configure": "Configure",
  "settings.remoteDevices.openFolder": "Open folder",
  "settings.remoteDevices.remove": "Remove device",
  "settings.remoteDevices.projects": "{count} projects",
  "settings.remoteDevices.logs": "Recent connection logs · {count}",
  "settings.remoteDevices.noLogs":
    "No logs for this connection yet. Reconnect to see live progress.",
  "settings.remoteDevices.empty":
    "No remote devices yet. Create a connection to save one. No project folder is required.",
  "settings.remoteDevices.noMatches": "No matching devices or projects.",
  "settings.remoteDevices.duplicate":
    "This device already exists. Configure or connect it from the device list.",
  "settings.remoteDevices.manualReconnect":
    "Device and project records are kept at startup. Start connections when you need them.",
  "settings.remoteDevices.disconnectTitle": "Disconnect this device?",
  "settings.remoteDevices.disconnectDescription":
    "Disconnect this device's {count} projects in this window and cancel pending reconnects. Remote task files and device records are kept.",
  "settings.remoteDevices.removeTitle": "Remove this device's records?",
  "settings.remoteDevices.removeDescription":
    "Remove the connection profile. Projects, files and running tasks are kept. You can add the device again later.",
};
