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
 *
 *  【拼音检索】可加 pinyin 字段（全拼 + 首字母，空格分隔），搜索时一并匹配：
 *    pinyin: 'qiandaobiaoshengchengqi qdbscq'   // 输入 qd 或签到q 都能命中
 *  不写该字段也能按 名称/描述/URL 搜索。
 *
 *  改完保存刷新页面即可生效。
 * ============================================================
 */

const LINKS = [
  // ==========================================================
  //  我的项目（本地子项目，放在 projects/ 文件夹下）
  // ==========================================================
  {
    name: '签到表生成器',
    url: './projects/sign-in-generator/index.html',
    desc: '登录 School 系统 · 按班级生成签到表 / 导出 Excel',
    mark: '签',
    avatar: './assets/icons/sign-in-generator.png',
    pinyin: 'qiandaobiaoshengchengqi qdbscq',
    cat: '我的项目'
  },
  {
    name: '点名系统',
    url: './projects/sign-in-generator/rollcall.html',
    desc: '登录 School 系统 · 学生触屏自助签到 / 点名结果导出',
    mark: '点',
    avatar: './assets/icons/rollcall.svg',
    pinyin: 'dianmingxitong dmxt',
    cat: '我的项目'
  },
  {
    name: '随机点名',
    url: './projects/sign-in-generator/random.html',
    desc: '选班级 · 掷骰子随机抽人（可设不重复）',
    mark: '骰',
    avatar: './assets/icons/random-rollcall.svg',
    pinyin: 'suijidianming sjdm',
    cat: '我的项目'
  },
  {
    name: '待办清单',
    url: './projects/todo/index.html',
    desc: '当天 / 长期 / 日期待办 · 上课日自动提醒考勤',
    mark: '办',
    avatar: './assets/icons/todo.svg',
    pinyin: 'daibanqingdan dbqd',
    cat: '我的项目'
  },
  {
    name: '一键考勤',
    url: './projects/attendance/index.html',
    desc: '展开名单 · 批量考勤 · 缺勤原因确认',
    mark: '勤',
    avatar: './assets/icons/attendance.svg',
    pinyin: 'yijiankaoqin yjkq',
    cat: '我的项目'
  },

  // ==========================================================
  //  工作（管理系统 · 登录入口）
  // ==========================================================
  {
    name: '反馈生成器',
    url: 'https://feedback.wxjifang.cn',
    desc: '反馈生成器 · 春秋季上传',
    mark: '馈',
    avatar: './assets/icons/auto/feedback.wxjifang.cn.png',
    pinyin: 'fankuishengchengqi fkscq',
    cat: '工作'
  },
  {
    name: 'School 管理系统',
    url: 'https://jf-alpha.com/accounts/login/?next=/dashboard/',
    desc: '管理后台 · 登录入口',
    mark: '校',
    avatar: './assets/icons/school-system.svg',
    pinyin: 'guanlixitong glxt',
    cat: '工作'
  },
  {
    name: '校管家',
    url: 'https://tms22.xiaogj.com/login.aspx',
    desc: '教务管理 · 账户登录',
    mark: '管',
    avatar: './assets/icons/auto/tms22.xiaogj.com.png',
    pinyin: 'xiaoguanjia xgj',
    cat: '工作'
  },
  {
    name: '菁优网',
    url: 'https://www.jyeoo.com/account/loginform?v=1&u=https%3a%2f%2fwww.jyeoo.com%2fques%2fsearch',
    desc: '题库 · 题目搜索 & 组卷',
    mark: '菁',
    avatar: './assets/icons/auto/www.jyeoo.com.png',
    pinyin: 'jingyouwang jyw',
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
    pinyin: 'github',
    cat: '常用'
  },
  {
    name: '哔哩哔哩',
    url: 'https://www.bilibili.com',
    desc: '视频学习 & 娱乐',
    mark: 'B',
    avatar: './assets/icons/bilibili-official.webp',
    pinyin: 'bilibili bl',
    cat: '常用'
  },
  {
    name: '软件管理',
    url: './projects/software/index.html',
    desc: '开火 / 签到点名器 · 下载与更新',
    mark: '软',
    avatar: './assets/icons/software.svg',
    pinyin: 'ruanjianguanli rjgl',
    cat: '常用'
  }
];
