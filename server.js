require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const port = 3000;

// .env 파일에서 API 키를 불러옵니다.
const { API_KEY, SECRET_KEY } = process.env;
const KIWOOM_API_BASE_URL = 'https://api.kiwoom.com';

let accessToken = null;
let tokenExpiration = null;

// 접근 토큰 발급 함수
async function getAccessToken() {
    if (!API_KEY || !SECRET_KEY) {
        console.error("API_KEY 또는 SECRET_KEY가 .env 파일에 설정되지 않았습니다.");
        return false;
    }

    try {
        console.log("접근 토큰 발급을 시도합니다.");
        const response = await axios.post(`${KIWOOM_API_BASE_URL}/oauth2/token`, {
            grant_type: "client_credentials",
            appkey: API_KEY,
            secretkey: SECRET_KEY
        }, {
            headers: { 'Content-Type': 'application/json;charset=UTF-8' }
        });

        const { access_token, expires_in } = response.data;
        if (access_token) {
            accessToken = access_token;
            // 토큰 만료 시간 설정 (현재 시간 + 만료 시간 초 * 1000)
            tokenExpiration = new Date().getTime() + (expires_in * 1000);
            console.log("접근 토큰이 성공적으로 발급되었습니다!");
            return true;
        } else {
            console.log("응답 데이터에 access_token 필드가 없거나, 다른 오류가 발생했습니다.");
            return false;
        }
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data, null, 2) : error.message;
        console.error('접근 토큰 발급 중 오류 발생:', errorMessage);
        accessToken = null;
        return false;
    }
}

// 토큰 유효성 검사 및 갱신
async function ensureTokenIsValid() {
    if (!accessToken || new Date().getTime() > tokenExpiration) {
        console.log("접근 토큰이 없거나 만료되어 새로 발급합니다.");
        return await getAccessToken();
    }
    return true;
}

app.use(express.static(path.join(__dirname, '')));

// 거래대금 상위 100개 종목 조회 API
app.get('/api/top-100-stocks', async (req, res) => {
    if (!await ensureTokenIsValid()) {
        return res.status(500).json({ message: 'API 인증에 실패했습니다. 토큰을 발급할 수 없습니다.' });
    }

    try {
        console.log("거래대금 상위 데이터를 요청합니다.");
        const response = await axios.get(`${KIWOOM_API_BASE_URL}/v1/tr/opt10032`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'appkey': API_KEY,
                'appsecret': SECRET_KEY,
                'tr_id': 'OPT10032',
            },
            params: { '시장구분': '000' }
        });

        if (response.data.rt_cd !== '0') {
            console.error('API 응답 오류:', response.data.msg1);
            // 토큰 오류일 경우 토큰을 무효화하여 다음 요청 시 재발급 받도록 함
            if (response.data.rt_cd === '-2') { // 토큰 오류 코드 (가정)
                accessToken = null;
            }
            return res.status(500).json({ message: `API 조회 실패: ${response.data.msg1}` });
        }

        const stocksData = response.data.output || [];
        const processedData = stocksData.map((stock, index) => ({
            rank: index + 1,
            name: stock.jongmok_name,
            price: parseInt(stock.stck_prpr, 10).toLocaleString(),
            change: parseInt(stock.prdy_vrss, 10).toLocaleString(),
            rate: stock.prdy_ctrt,
            volume: parseInt(stock.acml_tr_pbmn, 10).toLocaleString(),
        }));
        res.json(processedData);

    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data, null, 2) : error.message;
        console.error('API 데이터 요청 중 오류 발생:', errorMessage);

        // 401 또는 403 에러 발생 시 토큰 만료로 간주하고 토큰을 초기화
        if (error.response && [401, 403].includes(error.response.status)) {
            accessToken = null;
        }
        res.status(500).json({ message: '데이터 조회 중 오류가 발생했습니다.' });
    }
});


app.listen(port, async () => {
    console.log(`서버가 http://localhost:${port} 에서 실행 중입니다.`);
    console.log(`이 서버는 실제 키움증권 API와 연동됩니다.`);
    console.log(`반드시 IP 주소 106.101.130.227 으로 등록된 PC에서 실행해야 합니다.`);
    await ensureTokenIsValid();
});