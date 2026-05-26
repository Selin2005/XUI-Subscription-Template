const https = require('https');
const fs = require('fs');
const path = require('path');

const cssUrl = 'https://unpkg.com/vazirmatn@33.0.0/Vazirmatn-font-face.css';
const cssPath = path.join(__dirname, 'public/css/vazirmatn.css');
const fontsDir = path.join(__dirname, 'public/fonts');

https.get(cssUrl, res => {
    let css = '';
    res.on('data', d => css += d);
    res.on('end', () => {
        const regex = /url\('?(fonts\/webfonts\/[a-zA-Z0-9-]+\.woff2)'?\)/g;
        let match;
        const downloads = [];
        let newCss = css;
        while((match = regex.exec(css)) !== null) {
            const link = match[1];
            const file = link.split('/').pop();
            const fontUrl = `https://unpkg.com/vazirmatn@33.0.0/${link}`;
            const fontPath = path.join(fontsDir, file);
            
            downloads.push(new Promise((resolve, reject) => {
                https.get(fontUrl, r => {
                    const f = fs.createWriteStream(fontPath);
                    r.pipe(f);
                    f.on('finish', () => { f.close(); resolve(); });
                });
            }));
            newCss = newCss.replace(link, `../fonts/${file}`);
        }
        Promise.all(downloads).then(() => {
            fs.writeFileSync(cssPath, newCss);
            console.log("Done downloading Vazirmatn!");
        });
    });
});
