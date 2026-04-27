const request = require('supertest');
const createApp = require('../src/index').createApp;

const app = createApp();
const storageService = require('../src/services/storage');

jest.mock('../src/services/storage');

describe('SME Invoice Upload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should upload PDF invoice successfully', async () => {
    const mockKey = 'invoices/uuid-test.pdf';
    const mockSignedUrl = 'https://signed-url.com';

    storageService.uploadFile.mockResolvedValue(mockKey);
    storageService.getSignedUrl.mockResolvedValue(mockSignedUrl);

    const response = await request(app)
      .post('/api/sme/invoice')
      .attach('invoice', Buffer.from('fake pdf content'), 'test.pdf')
      .set('Content-Type', 'multipart/form-data');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: 'Invoice uploaded successfully',
      fileKey: mockKey,
      signedUrl: mockSignedUrl,
    });
    expect(storageService.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      'test.pdf',
      'application/pdf'
    );
  });

  it('should return 400 if no file provided', async () => {
    const response = await request(app)
      .post('/api/sme/invoice')
      .set('Content-Type', 'multipart/form-data');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invoice file is required');
  });

  it('should return 400 if file is not PDF', async () => {
    const response = await request(app)
      .post('/api/sme/invoice')
      .attach('invoice', Buffer.from('fake content'), 'test.txt')
      .set('Content-Type', 'multipart/form-data');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Only PDF files are allowed');
  });
});