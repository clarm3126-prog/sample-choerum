const numbersContainer = document.getElementById('numbers');
const generateBtn = document.getElementById('generate-btn');

function generateNumbers() {
    const numbers = [];
    while (numbers.length < 6) {
        const randomNumber = Math.floor(Math.random() * 45) + 1;
        if (!numbers.includes(randomNumber)) {
            numbers.push(randomNumber);
        }
    }
    numbers.sort((a, b) => a - b);

    numbersContainer.innerHTML = '';

    for (const number of numbers) {
        const numberDiv = document.createElement('div');
        numberDiv.classList.add('number');
        numberDiv.textContent = number;

        let color;
        if (number <= 10) {
            color = '#f44336';
        } else if (number <= 20) {
            color = '#ff9800';
        } else if (number <= 30) {
            color = '#ffeb3b';
        } else if (number <= 40) {
            color = '#4caf50';
        } else {
            color = '#2196f3';
        }
        numberDiv.style.backgroundColor = color;

        numbersContainer.appendChild(numberDiv);
    }
}

generateBtn.addEventListener('click', generateNumbers);

generateNumbers(); // Initial generation
