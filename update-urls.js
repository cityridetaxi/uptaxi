const fs = require('fs');
const path = require('path');
const dir = './public';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') || f.endsWith('.js'));

files.forEach(f => {
    let p = path.join(dir, f);
    let content = fs.readFileSync(p, 'utf8');
    let original = content;

    content = content.replace(/['"]([\w-]+)\.html['"]/g, (match, p1) => {
        // Exclude index if we want / instead of /index
        if (p1 === 'index') return "'/'";
        return `'/${p1}'`;
    });

    content = content.replace(/href="([\w-]+)\.html"/g, (match, p1) => {
        if (p1 === 'index') return 'href="/"';
        return `href="/${p1}"`;
    });
    
    // Fallback for random index.html 
    content = content.replace(/index\.html/g, '/');

    if (content !== original) {
        fs.writeFileSync(p, content);
        console.log('Updated ' + f);
    }
});
