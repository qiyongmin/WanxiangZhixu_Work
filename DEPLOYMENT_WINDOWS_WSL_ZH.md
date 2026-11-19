# 万象知序 · Work：Windows + WSL2 安装与使用指南

> **给第一次部署的同事**：不需要了解现有用户的数据和工程历史。框架已采用 MIT License；待正式发布到 GitHub 后，可 Clone 纯框架源码，并在自己的电脑创建**完全空白、独立**的工作空间。所有 Skills/Prompts/MCP/Agents 资料均留在本地。本指南不涉及部署公司服务器、多人共享或对外开放网络访问。

返回：[README / 项目总览](README.md) · [当前架构](ARCHITECTURE.md) · [运维与备份](OPERATIONS.md)

## 一、先决定部署方式

**推荐：Windows 11 → WSL2/Ubuntu 24.04 LTS 运行后台 → Windows 浏览器打开网站。**

不需要在 Windows 和 WSL 内各安装一套 KB_Work，也不需要在 Windows 上运行 Python Server。

| 方案 | 状态 | 说明 |
|---|---|---|
| Windows 11 + WSL2 | 推荐 | 当前 Linux/WSL 开发及验证路径 |
| 支持 WSL2 的 Windows 10 | 可行 | 受系统版本及公司 IT 策略限制 |
| Ubuntu Linux 本机 | 可行 | 通用网页、文件与任务功能；无法使用 WSL 专属的 Windows Explorer 桥接 |
| Windows 原生 Python | 暂不支持完整交付 | 现有 `start.bat` 不是全平台验收证明，`stop.bat`、文件夹打开、Office 转换尚有兼容问题 |

**资料存储位置**：建议 Linux Home，例如 `~/workspace/KB_Work`。不要把 Linux SQLite 放在 `/mnt/c/` 或 Windows 网络盘上长期使用，更不要用 Windows Python 访问 `\\wsl.localhost\...` 内的 SQLite。

## 二、需要安装哪些东西？

| 软件 / 依赖 | 是否必须 | 用途 |
|---|---|---|
| WSL2 + Ubuntu | Windows 推荐方案必须 | 运行 Python 后台服务 |
| Python 3.12+ | 必须 | API、SQLite、文件服务 |
| Git | 必须 | Clone 审核后公开的 GitHub 框架源码 |
| Node.js 22.12+ + npm | 必须 | 编译 React 前端，不能使用过旧 Node 18 |
| Python `cryptography` | 必须 | 通过 `requirements.txt` 安装，保护本地 Provider 配置 |
| LibreOffice | **建议安装** | Word/Excel/PPT 转换为 PDF 只读网页预览 |
| Python `openpyxl` | **建议安装** | Excel XLSX 独立 Sheet Browser |
| Noto CJK Fonts | 可选 | 提高中文、日文等 Office PDF 字体显示效果 |

**特别说明 LibreOffice：** 没有它，任务、Notes、Kanban、Materials 上传/关联/下载都可以使用；只是 Word、PowerPoint、Excel 的高保真 PDF 预览不可用或退化为文本预览。Excel Sheet Browser 则另外依赖 `openpyxl`。万象知序不通过网页直接编辑 Office 原件，修改原件要在可信本机目录完成。

## 三、安装 WSL2 和 Ubuntu

在 Windows 开始菜单查找 **PowerShell**，以管理员身份打开：

```powershell
wsl --install -d Ubuntu-24.04
```

如系统提示，请重启电脑。随后打开 Ubuntu 程序，按提示设置 Linux 用户名和密码。

在 PowerShell 检查：

```powershell
wsl --list --verbose
```

Ubuntu 的 **VERSION** 应为 `2`。如果公司政策禁止启用虚拟化、WSL 或 Microsoft Store，需先由 IT 部门批准安装。不要自行绕过设备安全策略。

## 四、在 Ubuntu/WSL 安装后台和预览依赖

以下所有命令都在 **Ubuntu 终端**执行，而不是 Windows PowerShell：

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip
python3 --version
git --version
```

安装 Node.js **22.x**。建议使用公司 IT 批准的安装源或版本管理器。假如已经安装并获批准使用 `nvm`：

```bash
nvm install 22
nvm use 22
node --version
npm --version
```

版本需至少为 `v22.12`；只在 Windows 安装 Node 并不能保证 Ubuntu 终端有可用的 `node` 和 `npm`。

安装 LibreOffice：

```bash
sudo apt install -y libreoffice fonts-noto-cjk
command -v libreoffice
libreoffice --version
```

看到 `/usr/bin/libreoffice` 及版本号即可。此时 DOCX、XLSX、PPTX 等文件可由服务器通过 LibreOffice `--headless` 转换为临时 PDF 预览，不覆盖原文件。公司设备应使用批准的软件包仓库。

## 五、从 GitHub 克隆 KB_Work

**前提：** 维护者提供正式公开的 GitHub 地址后，按该地址 Clone。项目采用 MIT License，首次公开提交仍需完成源码隐私、第三方依赖许可、干净 Git 历史及安装验证。

```bash
mkdir -p ~/workspace
cd ~/workspace

git clone <OFFICIAL_APPROVED_GITHUB_REPOSITORY_URL> KB_Work
cd KB_Work
```

URL 为占位符，不能当作已经存在的公开仓库。请使用官方审核发布后的地址，不要镜像旧 GitLab 历史，也不要复制其他人的 `content/`、`library/`、`projects/`、`.agents/` 和 `.backups/`。这是创建自己的独立工作库，不是恢复他人的数据。

## 六、安装 Python 和前端依赖

建议为每位同事创建自己的 Python 虚拟环境，不影响电脑中的其他 Python 项目：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt

# 可选但推荐：启用 XLSX Sheet Browser
python -m pip install openpyxl

npm --prefix web ci
npm --prefix web run build
```

执行后生成 `app/`，这是网站最终运行的前端页面，不需要提交到 GitHub。公司内部如有 Node/npm/Python 私有镜像，请按公司的批准方案设置再安装。

## 七、创建本人全新数据空间

**第一次安装时运行一次：**

```bash
python tools/work_init.py
```

会创建独立的 Work SQLite、File Hub 目录、Notes V3 结构、Agent 本地说明和四个默认 Section：

- Initiatives
- Team Management
- Knowledge
- Projects

初始 **0 个真实项目、0 条任务**，不会带入其他人的资料。如果数据库已存在，初始化器会拒绝覆盖，不用手动删除 SQLite。

可选操作：如果你想先体验一套纯虚构的演示数据，并且数据库确实全空，可以手动执行：

```bash
python tools/work_demo.py --confirm-synthetic-demo
```

此 Demo 绝不会自动运行。想要彻底空白的新库，就跳过它。

运行只读检查：

```bash
python tools/work_doctor.py
```

`readyToStart: true` 表示主要运行前提已就绪；输出中还会明确显示 `libreOfficePathFound` 与 `xlsxSheetBrowserDependency` 的状态。即使 LibreOffice 缺失，也不阻止核心模块启动。

## 八、启动网站

```bash
./start.sh 8001 --no-browser
python tools/work_server_health.py 8001 --wait
```

打开 Windows 上的 Edge/Chrome，在地址栏输入：

**http://localhost:8001/app/**

不要打开 `file:///...`，也不要尝试让其他同事通过你的内网 IP 打开：当前产品是 localhost-only 单用户模式，尚未配套企业 SSO 和网络访问控制。

停止和重新启动：

```bash
./stop.sh 8001
./start.sh 8001 --no-browser
```

如果希望服务器跟随当前终端运行并通过 Ctrl+C 停止，也可运行：

```bash
./start.sh 8001 --foreground --no-restart
```

## 九、第一次运行的验收清单

- **页面**：左上方看到万象知序 · Work 和 Logo，Cockpit、Tree 正常加载。
- **数据隔离**：没有别人的项目、Notes、Materials。
- **任务**：新建 Initiative、Workstream、Task，尝试 Status/Priority/Due，重新打开后保存仍在。
- **Notes**：尝试新建 Section/Page、输入文字、等待自动保存并刷新验证。
- **Materials**：仅上传虚构测试文档，确认支持预览与 Download。
- **LibreOffice**：上传测试 DOCX/PPTX/XLSX，尝试 PDF Preview；如果无 PDF，先检查 LibreOffice 是否安装、软件 PATH 是否正确。
- **Excel**：确认 XLSX Sheet Browser；没有 `openpyxl` 时不可用属于预期。
- **文件定位**：在运行 WSL 的同一台 Windows 电脑上，Materials 的 “Open Storage Location” 可使用 WSL/Windows Explorer 集成。
- **重启**：停止再启动，确认数据仍在且 SQLite 未被重建。

## 十、常见问题

**Q：我能直接在 Windows 上双击 `start.bat` 运行吗？**

可能可以在本地 Windows NTFS 目录启动一个 Python Server，但**当前并未验收为完整 Windows 原生版本**：安全停止逻辑依赖 Linux `/proc`，本机打开资料目录依赖 WSL，Office PDF 转换也尚未完整测试 Windows 程序路径。因此给其他同事部署时请使用本指南的 WSL2 方案，暂不要把 `start.bat` 作为标准部署入口。

**Q：Office Preview 显示 LibreOffice not installed？**

在运行服务器的 **同一个 WSL Ubuntu 环境**中执行：

```bash
command -v libreoffice
libreoffice --version
```

安装后可以重新启动 KB_Work；若公司使用自定义软件目录，请 IT 确保 `libreoffice` 或 `soffice` 在该服务器进程的 PATH。

**Q：Excel Sheet Browser 提示缺失？**

```bash
source .venv/bin/activate
python -m pip install openpyxl
```

**Q：Node/Python 明明安装过，但命令显示找不到？**

确认是在 Ubuntu 内执行，而不是 Windows PowerShell。Python 虚拟环境需要使用 `source .venv/bin/activate` 激活，Node 也应安装在 Linux 环境内。

**Q：打开网站是空白页面 / 新代码没出现？**

确认 `npm --prefix web run build` 成功、`/app/` URL 正确，执行 `./start.sh 8001 --no-browser` 后刷新浏览器；如果端口被其他服务占用，不要强制结束不认识的进程。

**Q：能否直接共享给公司同事、用手机访问我电脑上的网站？**

目前不能把 localhost-only 的开发版本当企业服务公开。GitHub Public 只共享已审核的 MIT 源码，不含本地业务资料；网站远程共享另需实现可靠的身份认证、权限控制、安全网络边界、备份和审计机制。

**Q：如何备份自己的资料？**

查看 [OPERATIONS.md](OPERATIONS.md)。备份是人工显式操作，不能把上传到 GitHub 的公开源码当作数据库备份。真正的业务库及附件必须保存在符合公司要求的存储和备份位置。

## 十一、相关文档

| 文档 | 用途 |
|---|---|
| [README.md](README.md) | 项目价值、英文完整安装步骤、限制和贡献入口 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | React / Python API / Work & File Hub 系统边界 |
| [OPERATIONS.md](OPERATIONS.md) | 启停、备份、清理、异常处理 |
| [SECURITY.md](SECURITY.md) | 安全与数据保护 |

---
**验证基线（2026-11-15）：** Ubuntu 24.04.4 LTS / WSL2，Python 3.12.3、Node.js 22.23.2、LibreOffice 24.2.7.2。使用临时虚构 DOCX 通过真实 Headless PDF 转换测试，前端 Vite 构建及通用源码独立 Clean Clone 已通过；尚未在 Windows 原生 Python 上完成端到端验收。
