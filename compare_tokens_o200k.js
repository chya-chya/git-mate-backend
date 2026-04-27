const fs = require('fs');
const yaml = require('js-yaml');
const { getEncoding } = require('js-tiktoken');

const encoding = getEncoding('o200k_base'); // For GPT-4o, GPT-4o-mini

const jsonData = fs.readFileSync('/tmp/test_data.json', 'utf8');
const data = JSON.parse(jsonData);

const jsonString = JSON.stringify(data);
const yamlString = yaml.dump(data, { indent: 2, lineWidth: -1 });

const jsonTokens = encoding.encode(jsonString).length;
const yamlTokens = encoding.encode(yamlString).length;

console.log('--- JSON (o200k_base) ---');
console.log('Tokens:', jsonTokens);

console.log('\n--- YAML (o200k_base) ---');
console.log('Tokens:', yamlTokens);

const tokenSavings = ((jsonTokens - yamlTokens) / jsonTokens * 100).toFixed(2);
console.log('\nToken Savings:', tokenSavings + '%');
