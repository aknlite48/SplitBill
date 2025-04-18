const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const pdfParse = require("pdf-parse");
const cors = require("cors");
//const Tesseract = require("tesseract.js");
const sharp = require('sharp');
const sizeOf = require('image-size');
const path = require("path");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5001;

// Usage tracking variables
let totalRequests = 0;
let totalTokensUsed = 0;
let estimatedCost = 0;
const COST_PER_1K_TOKENS = 0.01; // Adjust

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// Set up rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 20 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { 
    success: false, 
    error: "Too many requests from this IP, please try again after 15 minutes" 
  }
});

// Apply rate limiting to upload routes
app.use(['/upload-pdf', '/upload-image'], apiLimiter);

// Request tracking middleware
app.use((req, res, next) => {
  if (req.path.includes('/upload-')) {
    totalRequests++;
    // Update the console with current stats
    updateConsoleStats();
  }
  next();
});

const isProduction = process.env.NODE_ENV === 'prod';
if (isProduction) {
  app.use(express.static(path.join(__dirname, 'walmart-bill-frontend/build')));
}

// Multer setup for file uploads with size limits
const upload = multer({ 
  dest: "uploads/",
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB max file size
  }
});

// Route to handle PDF uploads
app.post("/upload-pdf", upload.single("pdf"), async (req, res) => {
    console.log("📥 Received request to /upload");

    if (!req.file) {
        console.log("❌ No file uploaded");
        return res.status(400).json({ error: "No file uploaded" });
    }

    try {
        const filePath = req.file.path;

        // Step 1️⃣: Extract text from PDF using pdf-parse
        console.log("🔍 Extracting text from PDF...");
        const fileBuffer = fs.readFileSync(filePath);
        const parsedData = await pdfParse(fileBuffer);
        const extractedText = parsedData.text;
        console.log("✅ Extracted text:", extractedText.substring(0, 500), "..."); // Show first 500 chars for debugging

        // Step 2️⃣: Send extracted text to OpenAI API for structured parsing
        console.log("🚀 Sending extracted text to OpenAI...");
        
        const input_prompt = `Extract a structured list of items, their costs, tax, and total from this 
        structured data parsed from a Walmart bill pdf. 
        if items are discounted, make to sure include only the prices of items post discount. 
        display the parsed items in json format. 
        the list of parsed items with their prices should be in a tuple list,
        each item in the list should have the "name" attribute and the "price" attribute,
        the tax and final price should be different attributes and should be called "tax" and "total".
        return pure JSON without code fences or additional text.`

        const openaiResponse = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4-turbo",  // Change to "gpt-3.5-turbo" if needed
                messages: [
                    { role: "system", content:  input_prompt},
                    { role: "user", content: extractedText }
                ],
                temperature: 0
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("✅ Received structured response from OpenAI");
        
        // Update token usage and cost
        if (openaiResponse.data.usage && openaiResponse.data.usage.total_tokens) {
            const tokensUsed = openaiResponse.data.usage.total_tokens;
            totalTokensUsed += tokensUsed;
            estimatedCost += (tokensUsed / 1000) * COST_PER_1K_TOKENS;
            updateConsoleStats();
            console.log(`📊 This request used ${tokensUsed} tokens`);
        }

        // Step 3️⃣: Delete file after processing
        fs.unlinkSync(filePath);

        // Step 4️⃣: Send extracted structured data to frontend
        try {
            const final_message = JSON.parse(openaiResponse.data.choices[0].message.content)
            //console.log(final_message)
            res.json({
                success: true,
                extractedData: final_message
            });
        } catch(error1) {
            console.log('json parsing failed')
            res.status(500).json({
                success: false,
                error: "parsing failed",
                details: error.response?.data || error.message
            });
        }


    } catch (error) {
        console.error("❌ OpenAI API Error:", error.response?.data || error.message);
        
        // Clean up the file if it exists
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (unlinkError) {
            console.error("Error deleting file:", unlinkError);
        }
        
        res.status(500).json({
            success: false,
            error: "OpenAI API failed",
            details: error.response?.data || error.message
        });
    }
});

// New endpoint to handle image uploads
app.post("/upload-image", upload.single("image"), async (req, res) => {
    console.log("📥 Received request to /upload-image");
    if (!req.file) {
      console.log("❌ No image uploaded");
      return res.status(400).json({ error: "No image uploaded" });
    }
    
    try {
      const filePath = req.file.path;
      
      // Check original image size and dimensions
      const imageBuffer = fs.readFileSync(filePath);
      const MAX_SIZE_MB = 15; // Max size in MB before base64 encoding
      const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
      console.log(`📏 Original image size: ${(imageBuffer.length / (1024 * 1024)).toFixed(2)}MB`);
      
      let processedImageBuffer;
      let base64Image;
      
      // Process image if needed
      if (imageBuffer.length > MAX_SIZE_BYTES) {
        console.log("🔄 Image too large, resizing...");
        
        try {
          // Get dimensions
          const dimensions = sizeOf(imageBuffer);
          console.log(`📐 Original dimensions: ${dimensions.width}x${dimensions.height}`);
          
          // Calculate scaling factor to get under size limit
          // Using an approximate compression ratio based on JPEG quality
          const scaleFactor = Math.sqrt(MAX_SIZE_BYTES / (imageBuffer.length * 1.5));
          const newWidth = Math.floor(dimensions.width * scaleFactor);
          const newHeight = Math.floor(dimensions.height * scaleFactor);
          
          console.log(`🔍 Resizing to: ${newWidth}x${newHeight}`);
          
          // Resize and optimize image
          processedImageBuffer = await sharp(imageBuffer)
            .resize(newWidth, newHeight)
            .jpeg({ quality: 85, progressive: true }) // Use JPEG for better compression
            .toBuffer();
            
          console.log(`📏 New image size: ${(processedImageBuffer.length / (1024 * 1024)).toFixed(2)}MB`);
          base64Image = processedImageBuffer.toString('base64');
        } catch (resizeError) {
          console.error("❌ Error resizing image:", resizeError);
          return res.status(400).json({ 
            success: false, 
            error: "Image processing failed", 
            details: "Unable to resize image. Try uploading a smaller image." 
          });
        }
      } else {
        // Use original image if size is acceptable
        processedImageBuffer = imageBuffer;
        base64Image = imageBuffer.toString('base64');
      }
      
      // Determine image mime type for base64 encoding
      const imageMimeType = req.file.mimetype || (processedImageBuffer !== imageBuffer ? 'image/jpeg' : 'image/png');
      
      console.log("🚀 Sending image directly to OpenAI Vision API...");
      console.log(`📄 Using mime type: ${imageMimeType}`);
      
      const openaiResponse = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4-turbo", // Using GPT-4 Vision model
          messages: [
            { 
              role: "system", 
              content: `Extract a structured list of items, their costs, tax, and total from this bill image.
                        Return the data in JSON format with the following structure:
                        {
                          "items": [{"name": "item name", "price": price_as_number}, ...],
                          "tax": tax_amount_as_number,
                          "total": total_amount_as_number
                        }
                        Return pure JSON without code fences or additional text.`
            },
            { 
              role: "user", 
              content: [
                { type: "text", text: "Extract the bill information from this image." },
                { 
                  type: "image_url", 
                  image_url: {
                    url: `data:image/${imageMimeType};base64,${base64Image}`
                  }
                }
              ]
            }
          ],
          max_tokens: 1000,
          temperature: 0
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );
      
      console.log("✅ Received structured response from OpenAI Vision");
      
      // Update token usage and cost
      if (openaiResponse.data.usage && openaiResponse.data.usage.total_tokens) {
          const tokensUsed = openaiResponse.data.usage.total_tokens;
          totalTokensUsed += tokensUsed;
          estimatedCost += (tokensUsed / 1000) * COST_PER_1K_TOKENS;
          updateConsoleStats();
          console.log(`📊 This request used ${tokensUsed} tokens`);
      }
      
      // Delete image files after processing
      fs.unlinkSync(filePath);
      
      // If we created a temporary resized file, also remove that
      if (processedImageBuffer !== imageBuffer && req.tempResizedPath) {
        try {
          fs.unlinkSync(req.tempResizedPath);
        } catch (err) {
          console.log("⚠️ Could not delete temporary resized image:", err.message);
        }
      }
      
      // Send structured data to frontend
      try {
        const final_message = JSON.parse(openaiResponse.data.choices[0].message.content);
        //console.log(final_message);
        res.json({
          success: true,
          extractedData: final_message
        });
      } catch (error1) {
        console.error("❌ JSON parsing failed:", error1.message);
        res.status(500).json({
          success: false,
          error: "Parsing failed",
          details: error1.message,
          rawContent: openaiResponse.data.choices[0].message.content
        });
      }
    } catch (error) {
      console.error("❌ Error processing image:", error.response?.data || error.message);
      
      // Attempt to clean up any files if an error occurs
      try {
        if (req.file && req.file.path) fs.unlinkSync(req.file.path);
        if (req.tempResizedPath) fs.unlinkSync(req.tempResizedPath);
      } catch (cleanupError) {
        console.log("⚠️ Error during file cleanup:", cleanupError.message);
      }
      
      res.status(500).json({
        success: false,
        error: "Image processing failed",
        details: error.response?.data || error.message
      });
    }
});

// Function to update console with usage statistics
function updateConsoleStats() {
  // Clear the console
  console.clear();
  
  // Print server info
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  
  // Print usage statistics
  console.log('\n===== OpenAI API Usage Statistics =====');
  console.log(`📊 Total Requests: ${totalRequests}`);
  console.log(`🔤 Total Tokens Used: ${totalTokensUsed.toLocaleString()}`);
  console.log(`💰 Estimated Cost: $${estimatedCost.toFixed(4)}`);
  console.log('=======================================\n');
}

// Catch-all GET route to handle client-side routing
// This should be placed AFTER all your specific API routes but BEFORE app.listen
if (isProduction) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'walmart-bill-frontend/build', 'index.html'));
  });
}

// Error handling middleware - should be last before starting server
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  
  // Clean up file if it exists
  if (req.file && req.file.path) {
    try {
      fs.unlinkSync(req.file.path);
    } catch (unlinkError) {
      console.error('Error deleting file during error handling:', unlinkError);
    }
  }
  
  res.status(500).json({
    success: false,
    error: "Server error",
    message: err.message
  });
});

// Start the server
app.listen(PORT, () => {
    // Initial console display
    updateConsoleStats();
});