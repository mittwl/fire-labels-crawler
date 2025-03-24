const fs = require('fs');
const puppeteer = require('puppeteer');
const path = require('path');
const sgMail = require('@sendgrid/mail');

// Set SendGrid API key from environment variable
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Helper sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to send email
function sendEmail(subject, body, toEmail) {
  const msg = {
    to: toEmail,
    from: 'your_email@example.com', // Use your verified SendGrid sender email
    subject: subject,
    text: body,
  };

  sgMail.send(msg)
    .then(() => {
      console.log('Email sent');
    })
    .catch((error) => {
      console.error(error);
    });
}

(async () => {
  // Get configuration from environment variables
  const baseCategoryUrl = process.env.CATEGORY_URL || 'https://example.com/category';
  // Default headless to true for CI environments (e.g. GitHub Actions)
  const headlessMode = process.env.HEADLESS_MODE ? process.env.HEADLESS_MODE.toLowerCase() === 'yes' : true;

  // Launch browser with specified headless mode
  const browser = await puppeteer.launch({ headless: headlessMode });
  const page = await browser.newPage();

  console.log(`Navigating to category landing page: ${baseCategoryUrl}`);
  await page.goto(baseCategoryUrl, { waitUntil: 'networkidle2' });
  await sleep(2000);

  // Automatically determine the number of pages in the category
  let maxPages = await page.evaluate(() => {
    // Adjust the selector based on the pagination structure of the site.
    const paginationContainer = document.querySelector('.pagination');
    if (paginationContainer) {
      const links = Array.from(paginationContainer.querySelectorAll('a'));
      const pageNumbers = links.map(link => parseInt(link.textContent)).filter(num => !isNaN(num));
      if (pageNumbers.length) {
        return Math.max(...pageNumbers);
      }
    }
    return 1; // Fallback to 1 if no pagination is found.
  });
  console.log(`Detected ${maxPages} pages in the category.`);

  let allProductUrls = [];

  // Iterate over each category page based on the determined maxPages
  for (let currentPage = 0; currentPage < maxPages; currentPage++) {
    // If your site uses a query parameter (like "&start=") for pagination, adjust the logic accordingly.
    const start = currentPage * 32;
    const pageUrl = baseCategoryUrl + (start > 0 ? `&start=${start}` : '');
    console.log(`Navigating to category page: ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'networkidle2' });

    // Scroll to the bottom to load any lazy-loaded content
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);

    // Extract product URLs by filtering anchor tags with '/p/' in the href
    const productUrls = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.filter(link => link.href.includes('/p/')).map(link => link.href);
    });

    console.log(`Page ${currentPage + 1}: Found ${productUrls.length} products.`);
    allProductUrls.push(...productUrls);
  }

  // Remove duplicate URLs, if any
  allProductUrls = [...new Set(allProductUrls)];
  console.log(`Total products collected: ${allProductUrls.length}`);

  // Array to store products with issues
  const missingLabelProducts = [];

  // Process each product page
  for (const url of allProductUrls) {
    const productPage = await browser.newPage();
    console.log(`Checking product: ${url}`);
    await productPage.goto(url, { waitUntil: 'networkidle2' });

    // Attempt to retrieve images from the scrollable container
    let carouselImages = [];
    try {
      await productPage.waitForSelector('div.scrollable img', { timeout: 10000 });
      await sleep(2000);
      carouselImages = await productPage.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('div.scrollable img'));
        return imgs.map(img => img.src);
      });
    } catch (err) {
      console.log(`Scrollable images not found on product page: ${url}`);
    }
    console.log(`Carousel images for ${url}:`, carouselImages);

    // Determine the missing type based on the images found
    let missingType = "";
    if (carouselImages.length === 0) {
      missingType = "Missing Image";
      console.log("No images found on the product page. Reporting as Missing Image.");
    } else if (carouselImages.some(src => src.includes('image-coming-soon.svg'))) {
      missingType = "Missing Image";
      console.log('Found "coming soon" icon. Reporting as Missing Image.');
    } else {
      const validFireLabels = carouselImages.filter(src => /_(5[0-9]|[7-9][0-9])\.jpg(\?|$)/.test(src));
      console.log(`Valid fire label images for ${url}:`, validFireLabels);
      if (validFireLabels.length === 0) {
        missingType = "Missing Fire Label";
        console.log('No valid fire label image found. Reporting as Missing Fire Label.');
      } else if (validFireLabels.length > 1) {
        missingType = "Multiple Fire Labels";
        console.log('Multiple valid fire label images found. Reporting as Multiple Fire Labels.');
      } else if (validFireLabels.length === 1 && carouselImages.length === 1) {
        missingType = "Single Fire Label Found";
        console.log('Valid fire label image found.');
      } else {
        console.log('Valid fire label image found.');
      }
    }

    if (missingType) {
      missingLabelProducts.push({ url, missingType });
    }

    await productPage.close();
  }

  await browser.close();

  // Create the folder if it doesn't exist
  const folderName = 'fire_label_report';
  if (!fs.existsSync(folderName)) {
    fs.mkdirSync(folderName);
  }

  // Generate a unique CSV file name with the current date (YYYY-MM-DD)
  const now = new Date();
  const formattedDate = now.toISOString().slice(0, 10);
  const fileName = path.join(folderName, `missing_fire_labels_${formattedDate}.csv`);

  // Write missing product URLs and types to a CSV file
  let csvContent = 'Product URL,Missing Type\n';
  missingLabelProducts.forEach(item => {
    csvContent += `"${item.url}","${item.missingType}"\n`;
  });
  fs.writeFileSync(fileName, csvContent);
  console.log(`CSV file "${fileName}" has been created with the following entries:`);
  console.log(missingLabelProducts);

  // Send email if there are any missing label products
  if (missingLabelProducts.length > 0) {
    const subject = 'Missing Fire Labels Report';
    const body = `There are ${missingLabelProducts.length} products with missing fire labels. Please check the attached report.`;
    sendEmail(subject, body, 'tim.dobson@thewarehouse.co.nz');
  }
})();
