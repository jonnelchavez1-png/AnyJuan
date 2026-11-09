// Bundles the app with esbuild, swapping the real Supabase package for the fake one. Output: tests-browser/out/
const path = require('path'); const fs = require('fs');
const esbuild = require(process.env.ESBUILD_PATH || '/opt/npm-tools/node_modules/esbuild');
const root = path.resolve(__dirname, '..'); const out = path.join(__dirname, 'out');
const modules = process.env.NPM_TOOLS || '/opt/npm-tools/node_modules';
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(root, 'src/main.jsx')], bundle: true, outfile: path.join(out, 'app.js'), format: 'iife', jsx: 'automatic', loader: { '.js': 'jsx' }, external: ['/brand/*'],
  define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://fake-project.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', VITE_ALLOW_SIGNUP: 'true' }), 'process.env.NODE_ENV': '"production"' },
  alias: { '@supabase/supabase-js': path.join(__dirname, 'fake-supabase.js') }, nodePaths: [modules], logLevel: 'warning', minify: false,
});
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AnyJuanPOS</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="app.js"></script></body></html>');
fs.copyFileSync(path.join(root, 'public/sw.js'), path.join(out, 'sw.js')); // the offline helper, so the page can register it
fs.copyFileSync(path.join(root, 'public/favicon.svg'), path.join(out, 'favicon.svg'));
fs.cpSync(path.join(root, 'public/brand'), path.join(out, 'brand'), { recursive: true }); // logo and sign-in photo
console.log('built', fs.statSync(path.join(out, 'app.js')).size, 'bytes');
