# 训成 · 培训签到证书平台

主办方创建课程、课次、限时签到码和证书样式；学员扫码签到并完成每讲测验，**考勤 + 测验双达标**才算结业。
迟到、缺课、补签、补发证书全部有明确状态与审计留痕；旧证书失效后，凭旧证书号仍能查到完整补发链与每次补发原因。

## 技术栈

- 后端：Node.js + Express + better-sqlite3（零外部依赖，数据落在单文件 `data.db`）
- 前端：原生 HTML/CSS/JS 单页应用（无构建步骤）
- 认证：登录后内存 Token（Bearer），区分主办方 / 学员两种角色

## 启动

```bash
npm install
npm run seed   # 可选：写入演示数据（重复执行会重建）
npm start      # http://localhost:3000
```

### 演示账号（密码均为 123456）

| 账号 | 角色 | 看点 |
|---|---|---|
| `org` | 主办方 王老师 | 管理课程、课次、签到码、补签、测验、签发/补发/吊销 |
| `zhang` | 学员 张三 | 已结业，证书经历两次补发，手上 2 张旧证（已失效）+ 1 张新证（有效） |
| `li` | 学员 李四 | 第一讲缺课、第三讲缺课、测验未达标，不可发证，可演示补签 |
| `student` | 学员体验号 | 可现场演示「课程大厅报名 → SAFE01 扫码签到 → 作答测验」 |

当前开讲课次「第一讲：安全生产法规」的签到码为 **SAFE01**（开课后 15 分钟宽限内签到算正常）。
首页「证书公开验真」输入张三的任意证书号（旧号或新号），都能看到 旧→新 的补发链与每一次补发原因。

## 核心业务规则

### 签到

- 每个课次由主办方生成签到码，含 `有效开始/结束` 时间窗；重复生成会自动作废旧码。
- 学员在窗口内签到：
  - 不晚于 `开课时间 + 宽限分钟` → **正常 present**
  - 超过宽限 → **迟到 late**
  - 窗口外 / 码停用 / 码错误 → 拒绝，提示联系主办方
- 不可重复签到。
- 主办方一键「结算缺课」：该课次所有未签到在学学员记 **缺课 absent**（幂等）。

### 补签

- 主办方在考勤明细中可把记录调整为 正常 / 迟到 / **补签 makeup** / 缺课（撤销补签）。
- 每条考勤带来源（扫码 scan / 人工结算 manual / 补签 makeup），所有变更写入 `attendance_logs`：谁、何时、做了什么、说明。

### 结业判定（`getProgress`）

同时满足：

1. 缺课次数 ≤ 课程允许缺课上限（默认 0）
2. 迟到次数 ≤ 课程允许迟到上限（默认 3；补签记为 makeup，不计迟到）
3. 每讲测验均已提交，且**平均分 ≥ 及格线**（同一测验多次提交取最高分）
4. 没有未结算的待签到课次

不合格时接口返回具体原因；主办方点击签发会被系统拒绝。

### 证书

- 证书样式支持 `{name}`、`{course}` 占位符，创建课程时自动生成默认样式。
- 证书号格式 `CERT-YYYYMMDD-随机码`。
- **补发 reissue**：重新校验结业条件 → 旧证置 `invalid` 并写入失效原因 → 生成新证 → `reissues` 表记录原因与操作人。
  - 已失效的证书不能再作为补发源（必须从当前最新证补发），保证链路单一直线、可追溯。
- **吊销 revoke**：有效证可因违规被置为 `revoked`。
- **公开验真** `GET /api/verify/:certNo`（无需登录）：返回持证人、课程、考勤/测验摘要、当前最新证，以及从链首张到最新证的完整列表和每一步补发原因。

## 数据模型

```
users            用户（organizer / student）
courses          课程（宽限、迟到/缺课上限、及格线）
sessions         课次
codes            签到码（时间窗 + 启用状态）
enrollments      报名
attendances      考勤（present/late/absent/makeup + 来源）
attendance_logs  考勤审计日志（扫码/结算/补签/撤销补签）
quizzes          课次测验（题目 JSON，单选）
quiz_attempts    答题记录（多次提交取最高）
certificate_templates 证书样式
certificates     证书（valid / invalid / revoked，superseded_by 指向新证）
reissues         补发记录（旧证、新证、原因、操作人）
```

## 主要 API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` `/login` | 注册 / 登录 |
| GET | `/api/verify/:certNo` | 公开证书验真 + 补发链 |
| GET/POST | `/api/organizer/courses` | 课程列表 / 新建 |
| GET/POST | `/api/organizer/courses/:id/sessions` | 课次 |
| POST | `/api/organizer/sessions/:sid/code` | 生成/重置签到码 |
| POST | `/api/organizer/codes/:id/toggle` | 停用/启用签到码 |
| POST | `/api/organizer/sessions/:sid/settle` | 结算缺课 |
| GET | `/api/organizer/sessions/:sid/attendance` | 考勤明细 + 审计日志 |
| POST | `/api/organizer/attendance/:aid/makeup` | 补签 / 修改 / 撤销补签 |
| GET/PUT | `/api/organizer/sessions/:sid/quiz` | 测验读写 |
| GET/POST | `/api/organizer/courses/:id/templates` | 证书样式 |
| POST | `/api/organizer/courses/:id/issue` | 签发证书（校验结业条件） |
| POST | `/api/organizer/certificates/:cid/reissue` | 补发（旧证失效+原因留痕） |
| POST | `/api/organizer/certificates/:cid/revoke` | 吊销 |
| GET | `/api/student/catalog` `/courses` | 课程大厅 / 我的学习（含进度判定） |
| POST | `/api/student/courses/:id/enroll` | 报名 |
| GET | `/api/student/sessions/:sid` | 课次详情（考勤+测验） |
| POST | `/api/student/checkin` | 签到码签到 |
| POST | `/api/student/quizzes/:qid/submit` | 提交测验 |
| GET | `/api/student/certificates` | 我的证书 |

## 目录

```
server/index.js    API 路由
server/services.js 认证、结算、结业判定、签发/补发链
server/db.js       表结构
server/seed.js     演示数据
public/            前端单页
```
