import dotenv from 'dotenv';
dotenv.config();

async function run() {
    const site = process.env.DD_SITE || 'datadoghq.com';
    const res = await fetch(`https://api.${site}/api/v2/rum/applications`, {
        headers: {
            'DD-API-KEY': process.env.DD_API_KEY,
            'DD-APPLICATION-KEY': process.env.DD_APP_KEY
        }
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
}
run();
