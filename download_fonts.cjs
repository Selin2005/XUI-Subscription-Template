const fs = require('fs');
const path = require('path');
const https = require('https');

const cssDir = path.join(__dirname, 'public/css');
const fontsDir = path.join(__dirname, 'public/fonts');
const jsDir = path.join(__dirname, 'public/js');

fs.mkdirSync(cssDir, { recursive: true });
fs.mkdirSync(fontsDir, { recursive: true });
fs.mkdirSync(jsDir, { recursive: true });

const downloadFile = (url, dest) => new Promise((resolve, reject) => {
    https.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
            return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
            return reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
        }
        const file = fs.createWriteStream(dest);
        response.pipe(file);
        file.on('finish', () => {
            file.close(resolve);
        });
    }).on('error', err => {
        fs.unlink(dest, () => reject(err));
    });
});

const downloadCSSAndFonts = async (cssUrl, cssFilename, isGoogleFonts = false) => {
    return new Promise((resolve, reject) => {
        const options = isGoogleFonts ? {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
            }
        } : {};
        
        https.get(cssUrl, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', async () => {
                const urlRegex = /url\((['"]?)(https?:\/\/[^\)]+?)\1\)/g;
                let match;
                let modifiedCss = data;
                const downloadPromises = [];
                
                while ((match = urlRegex.exec(data)) !== null) {
                    const fontUrl = match[2];
                    if (fontUrl.endsWith('.woff2') || fontUrl.endsWith('.woff') || fontUrl.endsWith('.ttf')) {
                        const filename = fontUrl.split('/').pop().split('?')[0];
                        const fontPath = path.join(fontsDir, filename);
                        
                        downloadPromises.push(downloadFile(fontUrl, fontPath).then(() => {
                            console.log(`Downloaded ${filename}`);
                        }));
                        
                        modifiedCss = modifiedCss.replace(fontUrl, `../fonts/${filename}`);
                    }
                }
                
                await Promise.all(downloadPromises);
                fs.writeFileSync(path.join(cssDir, cssFilename), modifiedCss);
                console.log(`Saved ${cssFilename}`);
                resolve();
            });
        }).on('error', reject);
    });
};

async function main() {
    try {
        console.log("Downloading qrcode.min.js...");
        await downloadFile('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js', path.join(jsDir, 'qrcode.min.js'));
        console.log("Downloaded qrcode.min.js");
        
        console.log("Downloading Google Fonts (Roboto)...");
        await downloadCSSAndFonts('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap', 'roboto.css', true);
        
        console.log("Downloading Vazirmatn Fonts...");
        await downloadCSSAndFonts('https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.0.0/Vazirmatn-font-face.css', 'vazirmatn.css', false);
        
        console.log("All assets downloaded successfully!");
    } catch (err) {
        console.error(err);
    }
}

main();
