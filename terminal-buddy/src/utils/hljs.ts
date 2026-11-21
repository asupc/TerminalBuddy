import hljs from 'highlight.js/lib/common';
import awk from 'highlight.js/lib/languages/awk';
import cmake from 'highlight.js/lib/languages/cmake';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import gradle from 'highlight.js/lib/languages/gradle';
import groovy from 'highlight.js/lib/languages/groovy';
import http from 'highlight.js/lib/languages/http';
import nginx from 'highlight.js/lib/languages/nginx';
import nix from 'highlight.js/lib/languages/nix';
import powershell from 'highlight.js/lib/languages/powershell';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';

// highlight.js/lib/common 已内置 37 种主流语言；这里补充开发/运维高频语言，
// 避免全量引入 ~192 种语言将 bundle 与 V8 堆撑大 ~700 KB。
hljs.registerLanguage('awk', awk);
hljs.registerLanguage('cmake', cmake);
hljs.registerLanguage('dart', dart);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('dos', dos);
hljs.registerLanguage('gradle', gradle);
hljs.registerLanguage('groovy', groovy);
hljs.registerLanguage('http', http);
hljs.registerLanguage('nginx', nginx);
hljs.registerLanguage('nix', nix);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('properties', properties);
hljs.registerLanguage('protobuf', protobuf);

export default hljs;
