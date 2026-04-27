const fs = require('fs');
const yaml = require('js-yaml');
const { getEncoding } = require('js-tiktoken');

const encoding = getEncoding('cl100k_base'); // Common encoding for GPT-4/GPT-3.5

const jsonData = fs.readFileSync('/tmp/test_data.json', 'utf8');
const data = JSON.parse(jsonData);

const jsonString = JSON.stringify(data);
const yamlString = yaml.dump(data, { indent: 2, lineWidth: -1 });

const jsonTokens = encoding.encode(jsonString).length;
const yamlTokens = encoding.encode(yamlString).length;

console.log('--- JSON ---');
console.log('Length (chars):', jsonString.length);
console.log('Tokens:', jsonTokens);

console.log('\n--- YAML ---');
console.log('Length (chars):', yamlString.length);
console.log('Tokens:', yamlTokens);

const tokenSavings = ((jsonTokens - yamlTokens) / jsonTokens * 100).toFixed(2);
console.log('\nToken Savings:', tokenSavings + '%');

// Also compare a "compact" JSON (no spaces) vs YAML
const compactJsonString = JSON.stringify(data);
const compactJsonTokens = encoding.encode(compactJsonString).length;
console.log('\n--- Compact JSON ---');
console.log('Tokens:', compactJsonTokens);

const compactVsYaml = ((compactJsonTokens - yamlTokens) / compactJsonTokens * 100).toFixed(2);
console.log('Compact JSON vs YAML Savings:', compactVsYaml + '%');
