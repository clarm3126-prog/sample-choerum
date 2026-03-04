document.addEventListener('DOMContentLoaded', () => {
    // 나중에 실제 서버를 분리할 경우, 이 주소만 변경하면 됩니다.
    const API_BASE_URL = ''; // 현재는 같은 서버에 있으므로 비워둡니다.

    fetch(`${API_BASE_URL}/api/top-100-stocks`)
        .then(response => {
            if (!response.ok) {
                // 서버에서 보낸 JSON 형식의 에러 메시지를 파싱하여 사용
                return response.json().then(err => { throw new Error(err.message || `HTTP error! status: ${response.status}`) });
            }
            return response.json();
        })
        .then(data => {
            populateStockTable(data);
        })
        .catch(error => {
            console.error('Error fetching stock data:', error);
            const tableBody = document.querySelector('#stock-table tbody');
            // 에러 메시지를 테이블에 직접 표시
            tableBody.innerHTML = `<tr><td colspan="6">${error.message}</td></tr>`;
        });
});

function populateStockTable(stocks) {
    const tableBody = document.querySelector('#stock-table tbody');
    tableBody.innerHTML = ''; // 기존 내용을 비웁니다.

    if (!stocks || stocks.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="6">표시할 데이터가 없습니다.</td></tr>';
        return;
    }

    stocks.forEach(stock => {
        const row = document.createElement('tr');

        const rank = document.createElement('td');
        rank.textContent = stock.rank;
        row.appendChild(rank);

        const name = document.createElement('td');
        name.textContent = stock.name;
        row.appendChild(name);

        const price = document.createElement('td');
        price.textContent = stock.price;
        row.appendChild(price);

        const change = document.createElement('td');
        change.textContent = stock.change;
        row.appendChild(change);

        const rate = document.createElement('td');
        rate.textContent = stock.rate;
        row.appendChild(rate);

        const volume = document.createElement('td');
        volume.textContent = stock.volume;
        row.appendChild(volume);

        tableBody.appendChild(row);
    });
}
