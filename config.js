/**
 * ============================================================
 *  Joker X 中转站 · 链接配置
 * ============================================================
 *  在这里增删条目。每一项结构如下：
 *
 *  {
 *    name:   '名称',
 *    url:    'https://...'  或  './projects/项目文件夹/index.html',
 *    desc:   '一句话描述（可选）',
 *    mark:   '签',            // 单字标识：无 logo 时显示（1 个汉字或 1-2 个字母）
 *    avatar: './assets/icons/xxx.svg',  // 可选：条目左侧的品牌图标
 *    cat:    '分类名'
 *  }
 *
 * 【外链】url 以 http:// 或 https:// 开头 → 新标签页打开
 * 【本地项目】url 写相对路径，如 './projects/demo/index.html'
 *            → 在当前页打开（项目文件夹放在根目录的 projects/ 下）
 *
 * 【条目图标】显示优先级（自动生效，一般不用管）：
 *  1. 显式 avatar 字段 —— 本地品牌图标，推荐 SVG 或透明底 PNG，
 *     深浅色下都清晰稳定（参考下面 GitHub / 哔哩哔哩的写法）；
 *  2. 外部网站自动使用其 favicon.ico（真实站点图标）；
 *  3. 都没有时显示 mark 的单字标识。
 *  图片加载失败会自动回退到 mark，图标位空间始终保留。
 *
 * 【深色适配】单色图标（黑 logo）可加 invert: true，
 *  深色主题自动反转为浅色，浅色主题保持原色（参考 GitHub 的写法）。
 *
 *  分类（cat）决定条目属于哪个分区，分区标题按数组顺序自动生成。
 *  改完保存刷新页面即可生效。
 *
 *  ------------------------------------------------------------------
 *  【公共展示版说明】本仓库公开时，工作/教务类系统的真实地址已替换为
 *  占位符（https://example.com）。请把你自己的链接填进来即可：
 *    - 直接改本文件里对应条目的 url / name / desc；
 *    - 「我的项目」里的相对路径指向 ./projects/ 下的子项目，
 *      本仓库未附带这些子项目，按需自行放入即可。
 *  ------------------------------------------------------------------
 * ============================================================
 */

const LINKS = [
  // ==========================================================
  //  我的项目（本地子项目，放在 projects/ 文件夹下）
  // ==========================================================
  {
    name: '签到表生成器',
    url: './projects/sign-in-generator/index.html',
    desc: '按班级生成签到表 · 导出 Excel / PDF',
    mark: '签',
    avatar: './assets/icons/sign-in-generator.png',
    cat: '我的项目'
  },
  {
    name: '一键考勤',
    url: './projects/attendance/index.html',
    desc: '一键完成今日课程考勤点名',
    mark: '勤',
    avatar: './assets/icons/attendance.svg',
    cat: '我的项目'
  },
  {
    name: '邀请码提取',
    url: './projects/invite-code-extractor/index.html',
    desc: '粘贴邀请话术 · 批量提取邀请码',
    mark: '码',
    avatar: './assets/icons/invite-code-extractor.svg',
    cat: '我的项目'
  },

  // ==========================================================
  //  工作台（示例占位，替换为你自己的后台入口）
  // ==========================================================
  {
    name: '反馈生成器',
    url: 'https://example.com/feedback',
    desc: '反馈生成 · 季节性上传',
    mark: '馈',
    cat: '工作'
  },
  {
    name: '管理系统',
    url: 'https://example.com/admin/',
    desc: '后台 · 登录入口',
    mark: '管',
    avatar: './assets/icons/school-system.svg',
    cat: '工作'
  },
  {
    name: '教务系统',
    url: 'https://example.com/login',
    desc: '教务管理 · 账户登录',
    mark: '教',
    cat: '工作'
  },

  // —— 常用 ——
  {
    name: 'GitHub',
    url: 'https://github.com',
    desc: '代码托管 & 开源社区',
    mark: 'GH',
    avatar: './assets/icons/github.svg',
    // 官方单色黑标：深色主题自动反转（黑标 → 白标）
    invert: true,
    cat: '常用'
  },
  {
    name: '哔哩哔哩',
    url: 'https://www.bilibili.com',
    desc: '视频学习 & 娱乐',
    mark: 'B',
    avatar: './assets/icons/bilibili-official.png',
    cat: '常用'
  }
];
