import globals from 'globals';
import {defineConfig} from 'eslint/config';
import parser from '@typescript-eslint/parser';
import obsidian from 'eslint-plugin-obsidianmd';
export default defineConfig([
 ...obsidian.configs.recommended,
 {files:['src/**/*.ts'],languageOptions:{globals:{...globals.browser,...globals.node},parser,parserOptions:{project:'./tsconfig.json'}},rules:{'obsidianmd/ui/sentence-case':['error',{ignoreWords:['Gmail','Google','Contacts','Cloud','Console','OAuth','People','Alex','CTO','ID','API','POST']}]}},
 {ignores:['apps/**','crates/**','node_modules/**','dist/**','main.js','tests/**','scripts/**']},
]);
