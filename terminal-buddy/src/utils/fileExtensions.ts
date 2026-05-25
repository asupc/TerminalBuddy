const TEXT_EXTENSIONS = new Set([
  // === 脚本/编程语言 ===
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.java', '.scala', '.kt', '.kts', '.groovy', '.clj', '.cljs', '.cljc', '.edn',
  '.cs', '.csx', '.vb', '.bas', '.frm', '.cls',
  '.cpp', '.c', '.cc', '.cxx', '.h', '.hpp', '.hh', '.hxx',
  '.py', '.pyw', '.pyx', '.pxd', '.pxi', '.ipynb',
  '.rs', '.rlib', '.go', '.rb', '.rbw', '.php', '.phtml', '.php3', '.php4', '.php5',
  '.swift', '.dart', '.lua', '.r', '.R', '.rmd', '.rnw', '.qmd',
  '.pl', '.pm', '.t', '.pod',
  '.hs', '.lhs', '.elm', '.purs', '.erl', '.hrl', '.ex', '.exs',
  '.fs', '.fsi', '.fsx', '.ml', '.mli',
  '.nim', '.cr', '.zig', '.odin', '.v', '.wren',
  '.jl', '.coffee', '.litcoffee', '.ls',
  '.sql', '.psql', '.mysql', '.hql', '.prql',
  '.proto', '.thrift', '.graphql', '.gql',
  '.f', '.f90', '.f95', '.f03', '.f08', '.for', '.ftn',
  '.pas', '.pp', '.dpr', '.dpk',
  '.rkt', '.scm', '.ss', '.cl', '.lisp', '.el',

  // === Web/标记语言 ===
  '.html', '.htm', '.xhtml', '.shtml', '.hta',
  '.css', '.scss', '.sass', '.less', '.styl', '.pcss',
  '.vue', '.svelte', '.astro',
  '.svg', '.mathml', '.rss', '.atom',

  // === ASP.NET / Razor ===
  '.cshtml', '.vbhtml', '.razor', '.aspx', '.ascx', '.ashx', '.asmx', '.master', '.sitemap',

  // === 模板引擎 ===
  '.jsp', '.jspx', '.tag', '.tld',
  '.haml', '.pug', '.jade', '.ejs', '.hbs', '.handlebars', '.mustache', '.nunjucks',
  '.twig', '.liquid', '.erb', '.slim',
  '.jinja', '.jinja2', '.mjml',
  '.njk', '.eta', '.ejs', '.kit',

  // === 配置/数据文件 ===
  '.json', '.jsonc', '.json5', '.jsonl', '.ndjson',
  '.xml', '.xsl', '.xslt', '.wsdl', '.xsd', '.dtd',
  '.yaml', '.yml', '.toml', '.ini', '.inf', '.cfg', '.conf', '.config',
  '.properties', '.env', '.envrc', '.editorconfig',
  '.gitignore', '.gitattributes', '.gitconfig', '.gitmodules', '.gitkeep',
  '.dockerignore', '.dockerfile', '.containerfile',
  '.eslintrc', '.eslintignore', '.prettierrc', '.prettierignore',
  '.babelrc', '.browserslistrc', '.stylelintrc', '.npmrc', '.nvmrc',
  '.bazel', '.bzl', '.bazelrc', '.buckconfig', '.gn', '.gni',
  '.cmake', '.mak', '.mk', '.gradle', '.sbt',
  '.lock', '.tf', '.tfvars', '.hcl', '.terraformrc',
  '.editorconfig', '.luacheckrc', '.pylintrc', '.flake8',

  // === Shell/脚本 ===
  '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.ps1xml',
  '.bashrc', '.bash_profile', '.profile', '.zshrc', '.zprofile',
  '.cshrc', '.tcshrc', '.kshrc',

  // === 文档/标记 ===
  '.md', '.mdx', '.markdown', '.mdown', '.mkdn', '.mkd', '.mdwn',
  '.txt', '.text', '.log', '.csv', '.tsv', '.tab',
  '.rst', '.rest', '.adoc', '.asciidoc', '.org',
  '.tex', '.sty', '.cls', '.bib', '.bbl', '.ltx',
  '.wiki', '.mediawiki', '.textile',
  '.diff', '.patch',
  '.man', '.1', '.2', '.3', '.4', '.5', '.6', '.7', '.8',

  // === 本地化/国际化 ===
  '.po', '.pot', '.lang', '.resx', '.resjson', '.resw',
  '.strings', '.xliff', '.xlf',

  // === MSBuild / .NET 项目 ===
  '.csproj', '.vbproj', '.fsproj', '.sln', '.xproj',
  '.props', '.targets', '.nuspec', '.pkgproj',
  '.wxs', '.wxi', '.wxl',

  // === 系统/服务文件 ===
  '.service', '.timer', '.socket', '.mount', '.target', '.automount', '.device',
  '.desktop', '.reg', '.plist', '.entitlements',
  '.manifest', '.appxmanifest',
  '.htaccess', '.htpasswd',

  // === Apple / iOS ===
  '.storyboard', '.xib', '.xcworkspacedata', '.pbxproj',
  '.xcconfig', '.bridgingheader', '.modulemap',

  // === 其他文本 ===
  '.ics', '.ical', '.vcard', '.vcf', '.ldif',
  '.asp', '.asa',
  '.sass', '.scss',
]);

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // JavaScript family
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',

  // Web
  '.html': 'html', '.htm': 'html', '.xhtml': 'html', '.shtml': 'html', '.hta': 'html',
  '.vue': 'html', '.svelte': 'html', '.astro': 'html',
  '.jsp': 'html', '.jspx': 'html', '.asp': 'html', '.asa': 'html',
  '.cshtml': 'html', '.vbhtml': 'html', '.razor': 'html',
  '.aspx': 'html', '.ascx': 'html', '.ashx': 'html', '.master': 'html',
  '.ejs': 'html', '.hbs': 'html', '.handlebars': 'html', '.mustache': 'html',
  '.twig': 'html', '.liquid': 'html', '.pug': 'html', '.jade': 'html',
  '.haml': 'html', '.slim': 'html', '.erb': 'html',
  '.jinja': 'html', '.jinja2': 'html', '.nunjucks': 'html', '.njk': 'html', '.mjml': 'html',

  // Styles
  '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css', '.styl': 'css', '.pcss': 'css',

  // Data
  '.json': 'json', '.jsonc': 'json', '.json5': 'json', '.jsonl': 'json',
  '.md': 'markdown', '.mdx': 'markdown', '.markdown': 'markdown',
  '.mdown': 'markdown', '.mkdn': 'markdown', '.mkd': 'markdown', '.mdwn': 'markdown',
  '.xml': 'xml', '.xsl': 'xml', '.xslt': 'xml', '.wsdl': 'xml', '.xsd': 'xml', '.dtd': 'xml',
  '.svg': 'xml', '.mathml': 'xml', '.rss': 'xml', '.atom': 'xml',
  '.xaml': 'xml', '.axml': 'xml',
  '.resx': 'xml', '.resjson': 'xml', '.resw': 'xml',
  '.plist': 'xml', '.entitlements': 'xml',
  '.storyboard': 'xml', '.xib': 'xml',
  '.csproj': 'xml', '.vbproj': 'xml', '.fsproj': 'xml',
  '.props': 'xml', '.targets': 'xml', '.nuspec': 'xml',
  '.wxs': 'xml', '.wxi': 'xml', '.wxl': 'xml',
  '.manifest': 'xml', '.appxmanifest': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml',

  // Shell
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
  '.bashrc': 'shell', '.bash_profile': 'shell', '.profile': 'shell',
  '.zshrc': 'shell', '.zprofile': 'shell',
  '.bat': 'bat', '.cmd': 'bat',
  '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell', '.ps1xml': 'powershell',

  // Languages
  '.java': 'java', '.scala': 'scala', '.kt': 'kotlin', '.kts': 'kotlin',
  '.groovy': 'groovy', '.clj': 'clojure', '.cljs': 'clojure', '.cljc': 'clojure',
  '.cs': 'csharp', '.csx': 'csharp', '.vb': 'vb',
  '.cpp': 'cpp', '.c': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.h': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.py': 'python', '.pyw': 'python', '.pyx': 'python',
  '.rs': 'rust', '.rlib': 'rust',
  '.go': 'go',
  '.rb': 'ruby', '.rbw': 'ruby',
  '.php': 'php', '.phtml': 'php', '.php3': 'php', '.php4': 'php', '.php5': 'php',
  '.swift': 'swift',
  '.dart': 'dart',
  '.lua': 'lua',
  '.r': 'r', '.R': 'r', '.rmd': 'r',
  '.pl': 'perl', '.pm': 'perl', '.t': 'perl',
  '.hs': 'haskell', '.lhs': 'haskell',
  '.elm': 'elm',
  '.purs': 'purescript',
  '.erl': 'erlang', '.hrl': 'erlang',
  '.ex': 'elixir', '.exs': 'elixir',
  '.fs': 'fsharp', '.fsi': 'fsharp', '.fsx': 'fsharp',
  '.ml': 'ocaml', '.mli': 'ocaml',
  '.nim': 'nim',
  '.jl': 'julia',
  '.coffee': 'coffeescript', '.litcoffee': 'coffeescript',
  '.sql': 'sql', '.psql': 'sql', '.mysql': 'sql', '.hql': 'sql',
  '.proto': 'proto', '.graphql': 'graphql', '.gql': 'graphql',
  '.f': 'fortran', '.f90': 'fortran', '.f95': 'fortran', '.for': 'fortran',
  '.pas': 'pascal', '.pp': 'pascal', '.dpr': 'pascal',
  '.lisp': 'lisp', '.cl': 'lisp', '.el': 'lisp',
  '.rkt': 'scheme', '.scm': 'scheme', '.ss': 'scheme',

  // Config / IaC
  '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.config': 'ini',
  '.properties': 'ini', '.editorconfig': 'ini',
  '.dockerfile': 'dockerfile', '.containerfile': 'dockerfile',
  '.tf': 'terraform', '.tfvars': 'terraform', '.hcl': 'terraform',
  '.cmake': 'cmake',
  '.gradle': 'gradle',

  // Documentation
  '.rst': 'restructuredtext', '.rest': 'restructuredtext',
  '.tex': 'latex', '.sty': 'latex', '.cls': 'latex', '.ltx': 'latex',
  '.diff': 'diff', '.patch': 'diff',

  // Other
  '.csv': 'plaintext', '.tsv': 'plaintext', '.tab': 'plaintext',
  '.log': 'plaintext', '.txt': 'plaintext', '.text': 'plaintext',
};

export function isTextFile(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = filePath.slice(dotIndex).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

export function getMonacoLanguage(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return 'plaintext';
  const ext = filePath.slice(dotIndex).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] || 'plaintext';
}

export function getFileName(filePath: string): string {
  const sep = filePath.includes('/') ? '/' : '\\';
  const parts = filePath.split(sep);
  return parts[parts.length - 1];
}
